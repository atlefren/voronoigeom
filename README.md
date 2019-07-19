# VoronoiGeom

A library for generating a voronoi diagram from any type of simple geometry

![Voronoi diagram](voronoi.png)

## Usage:

`npm install voronoigeom`

```javascript
const voronoiGeom = require('voronoigeom');

const features = []; // an array of GeoJson Features

const voronoiPolys = voronoiGeom(features);
// an array of GeoJson Polygon Features
```

```typescript
  function voronoiGeom(originalFeatures: GeometryFeature[], numEmpty = 0: number, boundingFeature = undefined: PolygonFeature?): PolygonFeature[]
```

- When passing in multi-geometries, a voronoi polygon is generated for each part of the multi-geom
- In order to create additional Voronoi polygons (ie empty polygons), pass a number as the second argument to voronoiGeom.
- In order to limit the created geometries by a polygon, add a geojson feature polygon as the third agrument

## Limitations

This does not scale well, seems to work ok for < 500 features
