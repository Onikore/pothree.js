/**
 * Named projections (http://epsg.io/) used by the map view and by Utils.computeAzimuth().
 * Registered with the proj4 global on first use, not at import: the core must load on pages without
 * proj4 (in the original this ran at import time of map.js).
 */
let registered = false;

export function registerProjections() {
	if (registered) return;
	registered = true;
	proj4.defs([
		['UTM10N', '+proj=utm +zone=10 +ellps=GRS80 +datum=NAD83 +units=m +no_defs'],
		['EPSG:6339', '+proj=utm +zone=10 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6340', '+proj=utm +zone=11 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6341', '+proj=utm +zone=12 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6342', '+proj=utm +zone=13 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6343', '+proj=utm +zone=14 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6344', '+proj=utm +zone=15 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6345', '+proj=utm +zone=16 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6346', '+proj=utm +zone=17 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6347', '+proj=utm +zone=18 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:6348', '+proj=utm +zone=19 +ellps=GRS80 +units=m +no_defs'],
		['EPSG:26910', '+proj=utm +zone=10 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26911', '+proj=utm +zone=11 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26912', '+proj=utm +zone=12 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26913', '+proj=utm +zone=13 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26914', '+proj=utm +zone=14 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26915', '+proj=utm +zone=15 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26916', '+proj=utm +zone=16 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26917', '+proj=utm +zone=17 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26918', '+proj=utm +zone=18 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
		['EPSG:26919', '+proj=utm +zone=19 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs '],
	]);
}
