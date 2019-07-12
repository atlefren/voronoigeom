const turfBbox = require('@turf/bbox').default;
const simplify = require('@turf/simplify').default;
const jsts = require('jsts');

const geometryFactory = new jsts.geom.GeometryFactory();
const geoJSONReader = new jsts.io.GeoJSONReader();
const geoJSONWriter = new jsts.io.GeoJSONWriter();

const range = n => [...Array(n).keys()];

const tail = lst => lst.slice(1);

const getFeatureBounds = features => turfBbox({type: 'FeatureCollection', features});

const toPoint = coord => geometryFactory.createPoint(new jsts.geom.Coordinate(coord[0], coord[1]));

const bboxToPoly = bbox => [
  [bbox[0], bbox[1]],
  [bbox[2], bbox[1]],
  [bbox[2], bbox[3]],
  [bbox[0], bbox[3]],
  [bbox[0], bbox[1]]
];

/**
 * Merge an array of polygons
 */
const mergePolys = polys => {
  let merged = polys.pop();

  while (polys.length) {
    const p = polys.pop();
    merged = merged.union(p);
  }
  return merged;
};

/**
 * Convert MultiGeoms to a individual components
 * Remove holes of polygons
 */
const getSimpleFeatures = features =>
  features
    .reduce((acc, f) => {
      if (f.geometry.type.startsWith('Multi')) {
        const baseType = f.geometry.type.replace('Multi', '');
        return [
          ...acc,
          ...f.geometry.coordinates.map(c => ({
            type: 'Feature',
            geometry: {type: baseType, coordinates: baseType === 'Polygon' ? [c[0]] : c}
          }))
        ];
      } else {
        if (f.geometry.type == 'Polygon') {
          return [...acc, {type: 'Feature', geometry: {type: 'Polygon', coordinates: [f.geometry.coordinates[0]]}}];
        }
        return [...acc, f];
      }
    }, [])
    .map(f => simplify(f, {tolerance: 0.0001, highQuality: false}));

/**
 * Get fractions along a line, ie:
 * getFractions(2) => [0.5]
 * getFractions(3) => [0.33, 0.66]
 */
const getFractions = num => {
  const base = 1 / num;
  const res = [base];
  while (res[res.length - 1] + base < 1) {
    res.push(res[res.length - 1] + base);
  }
  return res;
};

const getAverageLength = lines => {
  const lengths = [];
  for (let line of lines) {
    if (line.length > 1) {
      for (let i = 1; i < line.length; i++) {
        const p1 = toPoint(line[i - 1]);
        const p2 = toPoint(line[i]);
        lengths.push(p1.distance(p2));
      }
    }
  }
  return lengths.reduce((sum, l) => sum + l, 0) / lengths.length;
};

/**
 * Gets points on the line between c1 and c2 so that the distance between points does
 * not exceed the average length
 */
const getInterpolatedPoints = (c1, c2, averageLength) => {
  const p1 = toPoint(c1);
  const p2 = toPoint(c2);
  const length = p1.distance(p2);

  const points = [];
  if (length > averageLength) {
    const numPoints = Math.ceil(length / averageLength);
    for (let fraction of getFractions(numPoints)) {
      const interpolated = jsts.linearref.LinearLocation.pointAlongSegmentByFraction(
        p1.getCoordinate(),
        p2.getCoordinate(),
        fraction
      );
      points.push([interpolated.x, interpolated.y]);
    }
  }
  return points;
};

/**
 * Get the individual coordinates that makes up a geometry
 * Makes sure there are no long streches, as this messes up the process
 */
const getCoordinates = features => {
  const lines = features.map(f => {
    if (f.geometry.type === 'Point') {
      return [f.geometry.coordinates];
    }
    if (f.geometry.type === 'LineString') {
      return f.geometry.coordinates;
    }
    if (f.geometry.type === 'Polygon') {
      return f.geometry.coordinates[0];
    }
  });

  const averageLength = getAverageLength(lines);

  let normalized = [];
  for (let line of lines) {
    normalized.push(line[0]);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const interpolated = getInterpolatedPoints(a, b, averageLength);
      normalized = [...normalized, ...interpolated];
      if (line[0][0] !== b[0] && line[0][1] !== b[1]) {
        //do not add last point of polygon again
        normalized.push(b);
      }
    }
  }
  return normalized;
};

/**
 * Uses jsts to create a voronoi diagram of the supplied coordinates
 * The Turf.js voronoi module threw an error on one of my inputs
 */
const jstsVoronoi = coordinates => {
  const coords = coordinates.map(c => geometryFactory.createPoint(new jsts.geom.Coordinate(c[0], c[1])));
  const input = geometryFactory.createMultiPoint(coords);
  const builder = new jsts.triangulate.VoronoiDiagramBuilder();
  builder.setSites(input);
  return builder.getDiagram(geometryFactory);
};

/**
 * Group voronoi plygons by the feature they belong to
 */
const groupByFeature = (voronoiPolys, features) => {
  const jstsGeoms = features.map(f => geoJSONReader.read(f.geometry));
  const groups = range(jstsGeoms.length).map(i => []);

  const numGeoms = voronoiPolys.getNumGeometries();
  for (let i = 0; i < numGeoms; i++) {
    const geom = voronoiPolys.getGeometryN(i);
    const idx = jstsGeoms.findIndex(g => g.intersects(geom));
    groups[idx].push(geom);
  }
  return groups;
};

const mergeVoronoiPolys = (voronoiPolys, features) => {
  const bounds = getFeatureBounds(features);
  const all = geoJSONReader.read({type: 'Polygon', coordinates: [bboxToPoly(bounds)]});

  return groupByFeature(voronoiPolys, features)
    .map(polygons => mergePolys(polygons)) //merge the polygons belonging to each feature
    .map(poly => all.intersection(poly)); //cut the diagram to the bounds of the features
};

/**
 * Create a set of voronoi polygons for a set of geometries
 */
const voronoiGeom = originalFeatures => {
  console.time('VoronioGeom');
  const features = getSimpleFeatures(originalFeatures);

  const coordinates = getCoordinates(features);

  const voronoiPolys = jstsVoronoi(coordinates);
  const merged = mergeVoronoiPolys(voronoiPolys, features);

  const res = merged.map(mp => ({type: 'Feature', geometry: geoJSONWriter.write(mp)}));

  console.timeEnd('VoronioGeom');
  return res;
};

module.exports = voronoiGeom;