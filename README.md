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

- When passing in multi-geometries, a voronoi polygon is generated for each part of the multi-geom
- In order to create additional Voronoi polygons (ie empty polygons), pass a number as the second argument to voronoiGeom.

## Limitations

This does not scale well, seems to work ok for < 500 features
