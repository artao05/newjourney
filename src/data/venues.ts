/**
 * Pilot venues and the data contracts that make them usable.
 *
 * A venue is more than a map centre. It is the small, explicit bundle of public
 * sources we need to make a race day legible: chart display, observations,
 * tide/current predictions, weather, and the land/depth assets used by routing.
 * Keeping the URLs and station identifiers here gives an ingest job (and the UI)
 * one source of truth instead of burying Portland-specific assumptions in maps.
 */

import type { BBox, LatLon } from '@/lib/types'

export interface DataSourceLink {
  label: string
  href: string
  /** What the source will power once its adapter is enabled. */
  purpose: string
}

export interface TideStation {
  id: string
  name: string
  position: LatLon
}

export interface Venue {
  id: string
  name: string
  region: string
  center: LatLon
  /**
   * A position that is definitely afloat, for starting the simulator and for any
   * default that has to be navigable.
   *
   * Deliberately separate from `center`. A map centre only has to frame the
   * venue nicely, and this venue's centre sits on a small island in Casco Bay —
   * which meant the simulator started the boat on land, and every land-avoided
   * route from it failed with "no legal move from the frontier". Verified against
   * the land mask in landmask.test.ts.
   */
  waterStart: LatLon
  /** Bounding box for a Casco Bay race-day forecast download, not an offshore route. */
  bbox: BBox
  defaultZoom: number
  tideStations: TideStation[]
  currentStations: TideStation[]
  observationStations: TideStation[]
  marineZones: string[]
  sources: DataSourceLink[]
}

/**
 * Portland / Casco Bay is the product pilot. The bbox covers the harbour, the
 * usual inshore racing water, and the nearby islands; a route can grow it when
 * marks demand it. All URLs are public source endpoints or landing pages so the
 * future venue-pack downloader can record provenance alongside downloaded data.
 */
export const PORTLAND_MAINE: Venue = {
  id: 'portland-maine',
  name: 'Portland & Casco Bay',
  region: 'Maine, USA',
  center: { lat: 43.655, lon: -70.205 },
  // Open water in Hussey Sound, clear of the island chain and of the shipping
  // channel, with room to manoeuvre in every direction.
  waterStart: { lat: 43.6675, lon: -70.1735 },
  bbox: { west: -70.34, south: 43.53, east: -69.98, north: 43.79 },
  defaultZoom: 11.5,
  tideStations: [
    {
      id: '8418150',
      name: 'Portland, ME',
      position: { lat: 43.6583, lon: -70.2433 },
    },
  ],
  currentStations: [
    {
      id: 'CAB1401',
      name: 'Portland Harbor Entrance',
      position: { lat: 43.628, lon: -70.2095 },
    },
  ],
  observationStations: [
    { id: '44007', name: 'East Hue and Cry Rock', position: { lat: 43.525, lon: -70.14 } },
    { id: '44031', name: 'Casco Bay', position: { lat: 43.57, lon: -70.06 } },
  ],
  marineZones: ['ANZ153', 'ANZ152', 'ANZ154'],
  sources: [
    {
      label: 'NOAA ENC presentation service',
      href: 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService',
      purpose: 'official US chart display and the source for depth, obstruction, and land extraction',
    },
    {
      label: 'NOAA CO-OPS station 8418150',
      href: 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=8418150&product=predictions&datum=MLLW&time_zone=gmt&units=metric&format=json',
      purpose: 'Portland tide predictions, water levels, and station meteorology',
    },
    {
      label: 'NOAA current prediction station CAB1401',
      // units=english, not metric: the response then declares "feet, knots" and the
      // velocities are in knots. metric returns cm/s, which nobody sails in.
      href: 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=newjourney&station=CAB1401&time_zone=gmt&units=english&format=json',
      purpose: 'Portland Harbor Entrance harmonic-current predictions; display as prediction, never a live sensor',
    },
    {
      label: 'NOAA GoMOFS',
      href: 'https://opendap.co-ops.nos.noaa.gov/thredds/catalog/NOAA/GOMOFS/MODELS/catalog.html',
      purpose: 'Gulf of Maine 700 m operational current, water-level, temperature, and salinity model',
    },
    {
      label: 'NDBC station 44007',
      href: 'https://www.ndbc.noaa.gov/data/realtime2/44007.txt',
      purpose: 'nearby buoy and C-MAN wind, wave, pressure, and sea-temperature observations',
    },
    {
      label: 'NWS Casco Bay forecast zone ANZ153',
      href: 'https://api.weather.gov/zones/forecast/ANZ153/forecast',
      purpose: 'official marine-zone forecasts, watches, warnings, and small-craft context',
    },
    {
      label: 'NOAA GFS / HRRR',
      href: 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl',
      purpose: 'owned forecast ingest after the Open-Meteo prototype path',
    },
    {
      label: 'NOAA RTOFS',
      href: 'https://registry.opendata.aws/noaa-rtofs/',
      purpose: 'global ocean-current fallback outside regional tide/current coverage',
    },
    {
      label: 'GEBCO bathymetry',
      href: 'https://www.gebco.net/data-products/gridded-bathymetry-data',
      purpose: 'coarse bathymetry display and conservative routing pre-filter',
    },
    {
      label: 'OSM land polygons',
      href: 'https://osmdata.openstreetmap.de/data/land-polygons.html',
      purpose: 'coastline geometry for the routing obstacle layer',
    },
  ],
}

export const PILOT_VENUE = PORTLAND_MAINE
