const turfBbox = require('@turf/bbox').default;
const simplify = require('@turf/simplify').default;
const jsts = require('jsts');

const geometryFactory = new jsts.geom.GeometryFactory();
const geoJSONReader = new jsts.io.GeoJSONReader();
const geoJSONWriter = new jsts.io.GeoJSONWriter();

const range = n => [...Array(n).keys()];

const getFeatureBounds = features => turfBbox({type: 'FeatureCollection', features});

const extendBounds = (bounds, fraction) => {
  const width = Math.abs(bounds[3] - bounds[1]);
  const height = Math.abs(bounds[2] - bounds[0]);
  const extend = Math.min(width, height) * fraction;
  return [bounds[0] - extend, bounds[1] - extend, bounds[2] + extend, bounds[3] + extend];
};

const toPoint = coord => geometryFactory.createPoint(new jsts.geom.Coordinate(coord[0], coord[1]));

const bboxToPoly = bbox => [
  [bbox[0], bbox[1]],
  [bbox[2], bbox[1]],
  [bbox[2], bbox[3]],
  [bbox[0], bbox[3]],
  [bbox[0], bbox[1]]
];

const coordInBBOX = bbox => [
  Math.random() * (bbox[2] - bbox[0]) + bbox[0],
  Math.random() * (bbox[3] - bbox[1]) + bbox[1]
];

const coordInPolygon = polygon => {
  const jstsGeom = geoJSONReader.read(polygon.geometry);
  const bbox = turfBbox(polygon);
  let coord = coordInBBOX(bbox);
  while (!jstsGeom.contains(toPoint(coord))) {
    coord = coordInBBOX(bbox);
  }
  return coord;
};

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

const coordsEqual = (a, b) => a[0] === b[0] && a[1] === b[1];

const intersects = (feature, coord) => {
  const p = toPoint(coord);
  const f = geoJSONReader.read(feature.geometry);
  return f.intersects(p);
};

const collides = (coord, coords, features) =>
  coords.some(c => coordsEqual(c, coord)) || features.some(f => intersects(f, coord));

const createCoords = (bounds, avoid, numCoordinates) => {
  const getCoord = Array.isArray(bounds) ? coordInBBOX : coordInPolygon;

  return range(numCoordinates).reduce((acc, i) => {
    let coord = getCoord(bounds);

    while (collides(coord, acc, avoid)) {
      coord = getCoord(bounds);
    }

    return [...acc, coord];
  }, []);
};

/**
 * Convert MultiGeoms to a individual components
 * Remove holes of polygons
 */
const getSimpleFeatures = (features, averageLineLength) =>
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
    .map(f => simplify(f, {tolerance: averageLineLength, highQuality: false}));

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

const getLines = features =>
  features.map(f => {
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

/**
 * Get the individual coordinates that makes up a geometry
 * Makes sure there are no long streches, as this messes up the process
 */
const getCoordinates = (features, averageLineLength) => {
  const lines = getLines(features);
  let normalized = [];
  for (let line of lines) {
    normalized.push(line[0]);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const interpolated = getInterpolatedPoints(a, b, averageLineLength);
      normalized = [...normalized, ...interpolated];
      if (!coordsEqual(line[0], b)) {
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

  const orphans = [];
  const numGeoms = voronoiPolys.getNumGeometries();
  for (let i = 0; i < numGeoms; i++) {
    const geom = voronoiPolys.getGeometryN(i);
    const idx = jstsGeoms.findIndex(g => g.intersects(geom));

    if (idx === -1) {
      orphans.push([geom]);
    } else {
      groups[idx].push(geom);
    }
  }
  return [...groups, ...orphans];
};

const mergeVoronoiPolys = (voronoiPolys, features) => {
  return groupByFeature(voronoiPolys, features).map(polygons => mergePolys(polygons)); //merge the polygons belonging to each feature
};

const isDiagramValid = (originalFeatures, emptyPoints, diagramFeatures) => {
  for (let f of originalFeatures) {
    const fg = geoJSONReader.read(f.geometry);
    const numContaining = diagramFeatures.filter(a => a.contains(fg)).length;
    if (numContaining !== 1) {
      return false;
    }
  }

  for (let i of emptyPoints) {
    const ig = toPoint(i);
    const numContaining = diagramFeatures.filter(b => b.contains(ig)).length;
    if (numContaining !== 1) {
      return false;
    }
  }
  return true;
};

const createVoronoiDiagram = (features, extraCoords, averageLineLength) => {
  const simplifiedFeatures = getSimpleFeatures(features, averageLineLength);
  let coordinates = getCoordinates(simplifiedFeatures, averageLineLength);
  const voronoiPolys = jstsVoronoi([...coordinates, ...extraCoords]);
  return mergeVoronoiPolys(voronoiPolys, features);
};

const getVoronoiFeatures = (originalFeatures, createCoords, averageLineLength, numCreate) => {
  let extraCoords = createCoords();
  let c = 0;
  while (true) {
    if (c > 1000) {
      throw new Error('Cannot generate in 1000 tries');
    }
    voronoiFeatures = createVoronoiDiagram(originalFeatures, extraCoords, averageLineLength);
    if (voronoiFeatures.length !== numCreate) {
      //place coords elsewhere to see if this helps
      extraCoords = createCoords();
    } else if (!isDiagramValid(originalFeatures, extraCoords, voronoiFeatures)) {
      //make mesh denser to avoid collisions
      averageLineLength = averageLineLength / 2;
    } else {
      return voronoiFeatures;
    }
    c++;
  }
};

/**
 * Create a set of voronoi polygons for a set of geometries
 */
const voronoiGeom = (originalFeatures, numEmpty = 0, boundingFeature = undefined) => {
  if (originalFeatures.length === 0 && numEmpty === 0) {
    return [];
  }

  let averageLineLength = getAverageLength(getLines(originalFeatures));
  const bounds = extendBounds(getFeatureBounds(originalFeatures), 0.01);

  const doCreateCoords = () =>
    numEmpty > 0 ? createCoords(boundingFeature ? boundingFeature : bounds, originalFeatures, numEmpty) : [];

  const numCreate = numEmpty + originalFeatures.length;
  const voronoiFeatures = getVoronoiFeatures(originalFeatures, doCreateCoords, averageLineLength, numCreate);

  const all = boundingFeature
    ? geoJSONReader.read(boundingFeature.geometry)
    : geoJSONReader.read({type: 'Polygon', coordinates: [bboxToPoly(bounds)]});
  const res = voronoiFeatures
    .map(poly => all.intersection(poly)) //cut the diagram to the bounds of the features;
    .map(mp => ({type: 'Feature', geometry: geoJSONWriter.write(mp)}))
    .reduce(
      (acc, p) =>
        p.geometry.type === 'MultiPolygon'
          ? [
              ...acc,
              ...p.geometry.coordinates.map(coordinates => ({
                type: 'Feature',
                geometry: {type: 'Polygon', coordinates}
              }))
            ]
          : [...acc, p],
      []
    );

  return res;
};

module.exports = voronoiGeom;
