"use strict";

/* global grist, window */

let amap;
let popups = {};
let selectedTableId = null;
let selectedRowId = null;
let selectedRecords = null;
let mode = 'multi';
let mapSource = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
let mapCopyright = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// Required, Label value
const Name = "Name";
// Required
const Longitude = "Longitude";
// Required
const GeoJSON = "GeoJSON";
const Latitude = "Latitude";
// Optional - switch column to trigger geocoding
const Geocode = 'Geocode';
// Optional - but required for geocoding. Field with address to find (might be formula)
const Address = 'Address';
// Optional - but useful for geocoding. Blank field which map uses
//            to store last geocoded Address. Enables map widget
//            to automatically update the geocoding if Address is changed
const GeocodedAddress = 'GeocodedAddress';
// Optional - column with JSON style for GeoJSON features (Leaflet path options)
const Style = 'Style';
// Optional - column to group features into toggleable map layers
const Layer = 'Layer';
// Optional - multiple columns to display in the popup
const Popup = 'Popup';
// Optional - permanent text label displayed on the feature
const Label = 'Label';
// Optional - JSON style for the label (bearing, fontSize, color, fontWeight, dynamicSize, minZoom, maxZoom, opacity)
const LabelStyle = 'LabelStyle';
let lastRecord;
let lastRecords;
let rawRecordsById = {};
let additionalLayersConfig = [];


//Color markers downloaded from leaflet repo, color-shifted to green
//Used to show currently selected pin
const selectedIcon =  new L.Icon({
  iconUrl: 'marker-icon-green.png',
  iconRetinaUrl: 'marker-icon-green-2x.png',
  shadowUrl: 'marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});
const defaultIcon =  new L.Icon.Default();



// Creates clusterIcons that highlight if they contain selected row
// Given a function `() => selectedMarker`, return a cluster icon create function
// that can be passed to MarkerClusterGroup({iconCreateFunction: ... } )
//
// Cluster with selected record gets the '.marker-cluster-selected' class
// (defined in screen.css)
//
// Copied from _defaultIconCreateFunction in ClusterMarkerGroup
//    https://github.com/Leaflet/Leaflet.markercluster/blob/master/src/MarkerClusterGroup.js
const selectedRowClusterIconFactory = function (selectedMarkerGetter) {
  return function(cluster) {
    var childCount = cluster.getChildCount();

    let isSelected = false;
    try {
      const selectedMarker = selectedMarkerGetter();

      // hmm I think this is n log(n) to build all the clusters for the whole map.
      // It's probably fine though, it only fires once when map markers
      // are set up or when selectedRow changes
      isSelected = cluster.getAllChildMarkers().filter((m) => m == selectedMarker).length > 0;
    } catch (e) {
      console.error("WARNING: Error in clusterIconFactory in map widget");
      console.error(e);
    }

    var c = ' marker-cluster-';
    if (childCount < 10) {
      c += 'small';
    } else if (childCount < 100) {
      c += 'medium';
    } else {
      c += 'large';
    }

    return new L.DivIcon({
        html: '<div><span>'
            + childCount
            + ' <span aria-label="markers"></span>'
            + '</span></div>',
        className: 'marker-cluster' + c + (isSelected ? ' marker-cluster-selected' : ''),
        iconSize: new L.Point(40, 40)
    });
  }
};

let geocoder = L.Control.Geocoder && L.Control.Geocoder.nominatim();
if (URLSearchParams && location.search && geocoder) {
  const c = new URLSearchParams(location.search).get('geocoder');
  if (c && L.Control.Geocoder[c]) {
    console.log('Using geocoder', c);
    geocoder = L.Control.Geocoder[c]();
  } else if (c) {
    console.warn('Unsupported geocoder', c);
  }
  const m = new URLSearchParams(location.search).get('mode');
  if (m) { mode = m; }
}

async function geocode(address) {
  const results = await geocoder.geocode(address);
  let v = results[0];

  if (v) {
    v = v.center;
  }

  return v;
}

async function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// If widget has wright access
let writeAccess = true;
// A ongoing scanning promise, to check if we are in progress.
let scanning = null;

async function scan(tableId, records, mappings) {
  if (!writeAccess) { return; }
  for (const record of records) {
    // We can only scan if Geocode column was mapped.
    if (!(Geocode in record)) { break; }
    // And the value in the column is truthy.
    if (!record[Geocode]) { continue; }
    // Get the address to search.
    const address = record.Address;
    // Little caching here. We will set GeocodedAddress to last address we searched,
    // so after next round - we will check if the address is indeed changed.
    // But this field is optional, if it is not in the record (not mapped)
    // we will find the location each time (if coordinates are empty).
    if (record[GeocodedAddress]) {
      if (record[GeocodedAddress] == record.Address) {
        // We have already (successfully or not) attempted to geocode this address, skip it
        continue;
      } else {
        // We have caching field, and last address is diffrent.
        // So clear coordinates (as if the record wasn't scanned before)
        record[Longitude] = null;
        record[Latitude] = null;
        record[GeoJSON] = null;
      }
    }
    // If address is not empty, and coordinates are empty (or were cleared by cache)
    if (address && !record[Longitude]) {
      // Find coordinates.
      const result = await geocode(address);
      // Update them, and update cache (if the field was mapped)
      await grist.docApi.applyUserActions([ ['UpdateRecord', tableId, record.id, {
        [mappings[Longitude]]: result?.lng ?? null,
        [mappings[Latitude]]: result?.lat ?? null,
        ...(GeocodedAddress in mappings && mappings[GeocodedAddress]) ? {[mappings[GeocodedAddress]]: address} : undefined
      }] ]);
      await delay(1000);
    }
  }
}

function scanOnNeed(mappings) {
  if (!scanning && selectedTableId && selectedRecords) {
    scanning = scan(selectedTableId, selectedRecords, mappings).then(() => scanning = null).catch(() => scanning = null);
  }
}

function showProblem(txt) {
  document.getElementById('map').innerHTML = '<div class="error">' + txt + '</div>';
}

// Little extra wrinkle to deal with showing differences.  Should be taken
// care of by Grist once diffing is out of beta.
function parseValue(v) {
  if (typeof(v) === 'object' && v !== null && v.value && v.value.startsWith('V(')) {
    const payload = JSON.parse(v.value.slice(2, v.value.length - 1));
    return payload.remote || payload.local || payload.parent || payload;
  }
  return v;
}

function getInfo(rec) {
  const result = {
    id: rec.id,
    name: parseValue(rec[Name]),
    lng: parseValue(rec[Longitude]),
    lat: parseValue(rec[Latitude]),
    geojson: parseValue(rec[GeoJSON]),
    style: Style in rec ? parseValue(rec[Style]) : null,
    layer: Layer in rec ? parseValue(rec[Layer]) : null,
    label: Label in rec ? parseValue(rec[Label]) : null,
    labelStyle: LabelStyle in rec ? parseValue(rec[LabelStyle]) : null,
  };
  return result;
}

function buildPopupContent(name, rawRec, mappings) {
  // If no Popup columns mapped, fall back to just the name
  if (!mappings || !(Popup in mappings) || !mappings[Popup] || !rawRec) {
    return DOMPurify.sanitize(String(name || ''));
  }
  const popupMappings = mappings[Popup];
  // allowMultiple mappings can be a single string or an array
  const colNames = Array.isArray(popupMappings) ? popupMappings : [popupMappings];
  if (colNames.length === 0) {
    return DOMPurify.sanitize(String(name || ''));
  }
  let html = '<div style="max-width:300px">';
  if (name) {
    html += '<strong>' + DOMPurify.sanitize(String(name)) + '</strong>';
  }
  for (const col of colNames) {
    const val = parseValue(rawRec[col]);
    if (val == null || val === '') { continue; }
    html += '<br><em>' + DOMPurify.sanitize(String(col)) + ':</em> '
          + DOMPurify.sanitize(String(val));
  }
  html += '</div>';
  return html;
}

// Recursively extract all coordinate points from a GeoJSON geometry
function extractPointsFromGeoJSON(geojson) {
  const points = [];

  function extractCoordinates(coords, depth) {
    if (depth === 0) {
      // We've reached a coordinate pair [lng, lat]
      points.push(new L.LatLng(coords[1], coords[0]));
      return;
    }

    // Recurse into nested arrays
    for (let i = 0; i < coords.length; i++) {
      extractCoordinates(coords[i], depth - 1);
    }
  }

  if (!geojson || !geojson.type) {
    return points;
  }

  try {
    const geometry = geojson.type === "Feature" ? geojson.geometry : geojson;

    if (!geometry || !geometry.coordinates) {
      return points;
    }

    // Determine nesting depth based on geometry type
    const depthMap = {
      Point: 0,
      LineString: 1,
      Polygon: 2,
      MultiPoint: 1,
      MultiLineString: 2,
      MultiPolygon: 3,
    };

    const depth = depthMap[geometry.type];
    if (depth !== undefined) {
      extractCoordinates(geometry.coordinates, depth);
    } else if (geometry.type === "GeometryCollection") {
      for (let i = 0; i < geometry.geometries.length; i++) {
        points.push(...extractPointsFromGeoJSON(geometry.geometries[i]));
      }
    }
  } catch (e) {
    console.error("Error extracting points from GeoJSON:", e);
  }

  return points;
}

// Fetch additional layers from other Grist tables based on config
async function fetchAdditionalLayers() {
  const results = [];
  if (!additionalLayersConfig || additionalLayersConfig.length === 0) {
    return results;
  }
  for (const config of additionalLayersConfig) {
    if (!config.table || !config.columns || !config.columns.GeoJSON) {
      console.warn("Skipping additional layer with missing table or GeoJSON column:", config);
      continue;
    }
    try {
      const tableData = await grist.docApi.fetchTable(config.table);
      if (!tableData || !tableData.id) { continue; }
      // Pivot column-oriented data to row-oriented records
      const geojsonCol = config.columns.GeoJSON;
      const nameCol = config.columns.Name;
      const styleCol = config.columns.Style;
      const features = [];
      for (let i = 0; i < tableData.id.length; i++) {
        const geojsonRaw = tableData[geojsonCol] ? tableData[geojsonCol][i] : null;
        if (!geojsonRaw) { continue; }
        let parsedGeoJSON;
        try {
          parsedGeoJSON = typeof geojsonRaw === 'string' ? JSON.parse(geojsonRaw) : geojsonRaw;
        } catch (e) {
          continue;
        }
        let style = {};
        if (styleCol && tableData[styleCol]) {
          const styleRaw = tableData[styleCol][i];
          if (styleRaw) {
            try {
              style = typeof styleRaw === 'string' ? JSON.parse(styleRaw) : styleRaw;
            } catch (e) { /* ignore */ }
          }
        }
        const name = (nameCol && tableData[nameCol]) ? tableData[nameCol][i] : null;
        features.push({ geojson: parsedGeoJSON, name: name, style: style });
      }
      results.push({
        layerName: config.layer || config.table,
        order: config.order ?? 0,
        interactive: config.interactive !== false,
        features: features,
      });
    } catch (e) {
      console.error("Error fetching additional table '" + config.table + "':", e);
    }
  }
  return results;
}

// Custom grouped layer control with collapsible groups
L.Control.GroupedLayers = L.Control.extend({
  options: {
    position: 'topright',
    collapsed: true,
  },

  // groups: { "Group Name": { "Sub Layer": L.Layer, ... }, ... }
  // overlays: { "Layer Name": L.Layer, ... } (ungrouped/standalone)
  initialize: function (groups, overlays, options) {
    L.setOptions(this, options);
    this._groups = groups || {};
    this._overlays = overlays || {};
  },

  onAdd: function (map) {
    this._map = map;
    var container = L.DomUtil.create('div', 'leaflet-control-layers');
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    var section = L.DomUtil.create('section', 'leaflet-control-layers-list', container);
    this._section = section;
    this._buildContent();

    if (this.options.collapsed) {
      if (!L.Browser.android) {
        L.DomEvent.on(container, 'mouseenter', this._expand, this);
        L.DomEvent.on(container, 'mouseleave', this._collapse, this);
      }
      var link = L.DomUtil.create('a', 'leaflet-control-layers-toggle', container);
      link.href = '#';
      link.title = 'Layers';
      if (L.Browser.touch) {
        L.DomEvent.on(link, 'click', L.DomEvent.stop);
        L.DomEvent.on(link, 'click', this._expand, this);
      } else {
        L.DomEvent.on(link, 'focus', this._expand, this);
      }
    } else {
      this._expand();
    }

    return container;
  },

  _expand: function () {
    L.DomUtil.addClass(this.getContainer(), 'leaflet-control-layers-expanded');
    return this;
  },

  _collapse: function () {
    L.DomUtil.removeClass(this.getContainer(), 'leaflet-control-layers-expanded');
    return this;
  },

  _buildContent: function () {
    var section = this._section;
    var overlaysDiv = L.DomUtil.create('div', 'leaflet-control-layers-overlays', section);

    // Add groups
    var hasGroups = false;
    for (var groupName in this._groups) {
      this._addGroup(overlaysDiv, groupName, this._groups[groupName]);
      hasGroups = true;
    }

    // Add separator between groups and standalone overlays
    if (hasGroups && Object.keys(this._overlays).length > 0) {
      L.DomUtil.create('div', 'leaflet-control-layers-separator', overlaysDiv);
    }

    // Add standalone overlays
    for (var name in this._overlays) {
      this._addOverlayRow(overlaysDiv, name, this._overlays[name]);
    }
  },

  _addOverlayRow: function (parent, name, layer) {
    var label = document.createElement('label');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'leaflet-control-layers-selector';
    input.checked = this._map.hasLayer(layer);
    var self = this;
    L.DomEvent.on(input, 'change', function () {
      if (input.checked) { self._map.addLayer(layer); }
      else { self._map.removeLayer(layer); }
    });
    var span = document.createElement('span');
    span.textContent = ' ' + name;
    label.appendChild(input);
    label.appendChild(span);
    parent.appendChild(label);
  },

  _addGroup: function (parent, groupName, layers) {
    var groupDiv = document.createElement('div');
    groupDiv.className = 'leaflet-control-layers-group';

    // Group header (div, not label, so toggle/name clicks don't affect checkbox)
    var header = document.createElement('div');
    header.className = 'leaflet-control-layers-group-header';

    var groupCb = document.createElement('input');
    groupCb.type = 'checkbox';
    groupCb.className = 'leaflet-control-layers-selector';
    groupCb.checked = true;

    var toggle = document.createElement('span');
    toggle.className = 'leaflet-control-layers-group-toggle';
    toggle.textContent = '\u25B6';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'leaflet-control-layers-group-name';
    nameSpan.textContent = ' ' + groupName;

    header.appendChild(groupCb);
    header.appendChild(toggle);
    header.appendChild(nameSpan);
    groupDiv.appendChild(header);

    // Children (collapsed by default)
    var childrenDiv = document.createElement('div');
    childrenDiv.className = 'leaflet-control-layers-group-children';
    childrenDiv.style.display = 'none';

    var childItems = [];
    var self = this;

    for (var layerName in layers) {
      (function (lName, lyr) {
        var childLabel = document.createElement('label');
        var childCb = document.createElement('input');
        childCb.type = 'checkbox';
        childCb.className = 'leaflet-control-layers-selector';
        childCb.checked = self._map.hasLayer(lyr);
        childItems.push({ input: childCb, layer: lyr });

        var childSpan = document.createElement('span');
        childSpan.textContent = ' ' + lName;
        childLabel.appendChild(childCb);
        childLabel.appendChild(childSpan);
        childrenDiv.appendChild(childLabel);

        L.DomEvent.on(childCb, 'change', function () {
          if (childCb.checked) { self._map.addLayer(lyr); }
          else { self._map.removeLayer(lyr); }
          self._updateGroupCb(groupCb, childItems);
        });
      })(layerName, layers[layerName]);
    }

    groupDiv.appendChild(childrenDiv);
    parent.appendChild(groupDiv);

    // Group checkbox toggles all children
    L.DomEvent.on(groupCb, 'change', function () {
      for (var i = 0; i < childItems.length; i++) {
        childItems[i].input.checked = groupCb.checked;
        if (groupCb.checked) { self._map.addLayer(childItems[i].layer); }
        else { self._map.removeLayer(childItems[i].layer); }
      }
      groupCb.indeterminate = false;
    });

    // Toggle expand/collapse for children
    var doToggle = function (e) {
      L.DomEvent.stop(e);
      var isHidden = childrenDiv.style.display === 'none';
      childrenDiv.style.display = isHidden ? '' : 'none';
      toggle.textContent = isHidden ? '\u25BC' : '\u25B6';
    };
    L.DomEvent.on(toggle, 'click', doToggle);
    L.DomEvent.on(nameSpan, 'click', doToggle);
  },

  _updateGroupCb: function (groupCb, childItems) {
    var allChecked = childItems.every(function (ci) { return ci.input.checked; });
    var someChecked = childItems.some(function (ci) { return ci.input.checked; });
    groupCb.checked = allChecked;
    groupCb.indeterminate = someChecked && !allChecked;
  },
});

// Fetch the display label of a column from Grist metadata
async function getColumnLabel(colId) {
  try {
    var colData = await grist.docApi.fetchTable('_grist_Tables_column');
    for (var i = 0; i < colData.id.length; i++) {
      if (colData.colId[i] === colId) {
        return colData.label[i] || colId;
      }
    }
  } catch (e) {
    console.warn('Could not fetch column label:', e);
  }
  return colId;
}

// Helper: add the appropriate layer control (grouped or flat)
function addLayerControl(map, mainLayerGroups, additionalLayerGroups, isLayerMode, layerGroupName) {
  var allOverlays = Object.assign({}, mainLayerGroups, additionalLayerGroups);
  var totalCount = Object.keys(allOverlays).length;
  if (totalCount <= 1) { return; }

  if (isLayerMode && Object.keys(mainLayerGroups).length > 1) {
    // Grouped control: main layers in a collapsible group, additional as standalone
    var groups = {};
    groups[layerGroupName] = mainLayerGroups;
    new L.Control.GroupedLayers(groups, additionalLayerGroups).addTo(map);
  } else {
    // Flat control (no Layer column or only one main group)
    L.control.layers(null, allOverlays).addTo(map);
  }
}

// Function to clear last added markers. Used to clear the map when new record is selected.
let clearMarkers = () => {};
let clearGeoJSONLayers = () => {};

let markers = [];
let geoJSONLayers = {};
let geoJSONStyles = {};
let labelTooltipRefs = []; // [{sublayer, opts}] — for zoom-dependent label updates
let savedMapView = null; // { center, zoom } — persisted across updateMap calls via moveend event

function updateMap(data, mappings) {
  data = data || selectedRecords;
  selectedRecords = data;
  if (!data || data.length === 0) {
    showProblem("No data found yet");
    return;
  }

  // Determine if we're in GeoJSON mode
  const isGeoJSONMode = mappings && GeoJSON in mappings && mappings[GeoJSON];

  // Check for mixed column usage and show warning
  if (isGeoJSONMode) {
    const hasCoordinateColumns = data.some(rec => 
      (Latitude in rec && rec[Latitude] != null) ||
      (Longitude in rec && rec[Longitude] != null) ||
      (Geocode in rec && rec[Geocode] != null)
    );
    if (hasCoordinateColumns) {
      const warningMsg =
        "GeoJSON column detected - ignoring Latitude, Longitude, and Geocode columns";
      console.warn(warningMsg);
      showProblem(warningMsg + ". GeoJSON takes precedence.");
    }
  } else {
    if (!(Longitude in data[0] && Latitude in data[0] && Name in data[0])) {
      showProblem(
        "Table does not yet have all expected columns: Name, Longitude, Latitude. You can map custom columns" +
          " in the Creator Panel.",
      );
      return;
    }
  }

  // Map tile source:
  //    https://leaflet-extras.github.io/leaflet-providers/preview/
  //    Old source was natgeo world map, but that only has data up to zoom 16
  //    (can't zoom in tighter than about 10 city blocks across)
  //
  const tiles = L.tileLayer(mapSource, { attribution: DOMPurify.sanitize(mapCopyright, {FORCE_BODY: true}), maxZoom: 22});

  const error = document.querySelector('.error');
  if (error) { error.remove(); }
  const isFirstLoad = !savedMapView;
  if (amap) {
    try {
      amap.off();
      amap.remove();
    } catch (e) {
      // ignore
      console.warn(e);
    }
  }
  const map = L.map('map', {
    layers: [tiles],
    wheelPxPerZoomLevel: 90, //px, default 60, slows scrollwheel zoom
  });

  // Track map view changes to preserve position across data updates
  map.on('moveend', function () {
    savedMapView = { center: map.getCenter(), zoom: map.getZoom() };
  });

  // Handle dynamic label sizing and min/max zoom visibility
  map.on('zoomend', function () {
    var currentZoom = map.getZoom();
    for (var i = 0; i < labelTooltipRefs.length; i++) {
      var ref = labelTooltipRefs[i];
      var tooltip = ref.sublayer.getTooltip();
      if (!tooltip) continue;
      var el = tooltip.getElement();
      if (!el) continue;
      var opts = ref.opts;
      // Min/max zoom visibility
      if (opts.minZoom != null && currentZoom < opts.minZoom) {
        el.style.display = 'none';
        continue;
      }
      if (opts.maxZoom != null && currentZoom > opts.maxZoom) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      // Dynamic font size scaling
      if (opts.dynamicSize && opts.fontSize) {
        var refZoom = opts.referenceZoom || 18;
        var scale = Math.pow(2, currentZoom - refZoom);
        el.style.fontSize = (opts.fontSize * scale) + 'px';
      }
    }
  });

  // Make sure clusters always show up above points
  // Default z-index for markers is 600, 650 is where tooltipPane z-index starts
  map.createPane('selectedMarker').style.zIndex = 620;
  map.createPane('clusters'      ).style.zIndex = 610;
  map.createPane('otherMarkers'  ).style.zIndex = 600;

  const points = []; //L.LatLng[], used for zooming to bounds of all markers

  popups = {}; // Map: {[rowid]: L.marker or L.geoJSON layer}
  geoJSONLayers = {};
  geoJSONStyles = {};
  labelTooltipRefs = [];
  const mainLayerGroups = {}; // { layerName: L.featureGroup } — from main table's Layer column
  const isLayerMode = isGeoJSONMode && mappings && Layer in mappings && mappings[Layer];

  if (isGeoJSONMode) {
    // GeoJSON mode — group features by Layer column value

    for (const rec of data) {
      const { id, name, geojson, style: rawStyle, layer: layerName, label, labelStyle } = getInfo(rec);

      if (!geojson) {
        continue;
      }

      let parsedGeoJSON;
      try {
        parsedGeoJSON =
          typeof geojson === "string" ? JSON.parse(geojson) : geojson;
      } catch (e) {
        console.error("Invalid GeoJSON for row", id, ":", e);
        continue;
      }

      // Extract points for bounds
      points.push(...extractPointsFromGeoJSON(parsedGeoJSON));

      // Parse and store style for this feature (used when toggling selection)
      let customStyle = {};
      if (rawStyle) {
        try {
          customStyle = typeof rawStyle === 'string' ? JSON.parse(rawStyle) : rawStyle;
        } catch (e) {
          console.error("Invalid Style JSON for row", id, ":", e);
        }
      }
      if (Object.keys(customStyle).length > 0) { geoJSONStyles[id] = customStyle; }

      // Create GeoJSON layer
      const layer = L.geoJSON(parsedGeoJSON, {
        style: Object.assign({
          opacity: id == selectedRowId ? 0.6 : 0.3,
          fillOpacity: id == selectedRowId ? 0.6 : 0.3,
        }, customStyle),
        pointToLayer: function (feature, latlng) {
          return L.marker(latlng, {
            icon: id == selectedRowId ? selectedIcon : defaultIcon,
            pane: id == selectedRowId ? "selectedMarker" : "otherMarkers",
          });
        },
        onEachFeature: function (feature, layer) {
          const popupHtml = buildPopupContent(name, rawRecordsById[id], mappings);
          layer.bindPopup(popupHtml);
          layer.on("click", () => {
            selectGeoJSONFeature(id);
          });
        },
      });

      // Add permanent label tooltip if Label column is mapped
      if (label) {
        var tooltipContent = DOMPurify.sanitize(String(label));
        var labelOpts = {};
        if (labelStyle) {
          try {
            labelOpts = typeof labelStyle === 'string' ? JSON.parse(labelStyle) : labelStyle;
          } catch (e) {
            console.error("Invalid LabelStyle JSON for row", id, ":", e);
          }
        }
        // Build inline styles for the label span (all styles go in HTML to avoid
        // relying on tooltipopen event, which doesn't fire for already-open permanent tooltips)
        var inlineStyles = ['display:inline-block'];
        if (labelOpts.bearing != null) inlineStyles.push('transform:rotate(' + Number(labelOpts.bearing) + 'deg)');
        if (labelOpts.fontSize) inlineStyles.push('font-size:' + labelOpts.fontSize + 'px');
        if (labelOpts.color) inlineStyles.push('color:' + labelOpts.color);
        if (labelOpts.fontWeight) inlineStyles.push('font-weight:' + labelOpts.fontWeight);
        if (labelOpts.opacity != null) inlineStyles.push('opacity:' + labelOpts.opacity);
        if (inlineStyles.length > 1) {
          tooltipContent = '<span style="' + inlineStyles.join(';') + '">' + tooltipContent + '</span>';
        }
        layer.eachLayer(function (sublayer) {
          sublayer.bindTooltip(tooltipContent, {
            permanent: true,
            direction: 'center',
            className: 'polygon-label',
          });
          // Track for zoom-dependent updates (dynamic sizing, min/max zoom)
          labelTooltipRefs.push({ sublayer: sublayer, opts: labelOpts });
        });
      }

      // Add to the appropriate layer group
      const groupName = (isLayerMode && layerName) ? String(layerName) : "Default";
      if (!mainLayerGroups[groupName]) {
        mainLayerGroups[groupName] = L.featureGroup();
      }
      mainLayerGroups[groupName].addLayer(layer);

      geoJSONLayers[id] = layer;
      popups[id] = layer;
    }

    // Add all layer groups to the map
    for (const groupName in mainLayerGroups) {
      map.addLayer(mainLayerGroups[groupName]);
    }

    clearGeoJSONLayers = () => {
      for (const groupName in mainLayerGroups) {
        map.removeLayer(mainLayerGroups[groupName]);
      }
    };
  } else {
    // Coordinates mode (original behavior)
    // Make this before markerClusterGroup so iconCreateFunction
    // can fetch the currently selected marker from popups by function closure

    markers = L.markerClusterGroup({
      disableClusteringAtZoom: 18,
      //If markers are very close together, they'd stay clustered even at max zoom
      //This disables that behavior explicitly for max zoom (18)
      maxClusterRadius: 30, //px, default 80
      // default behavior clusters too aggressively. It's nice to see individual markers
      showCoverageOnHover: true,

      clusterPane: "clusters", //lets us specify z-index, so cluster icons can be on top
      iconCreateFunction: selectedRowClusterIconFactory(
        () => popups[selectedRowId],
      ),
    });

    markers.on("click", (e) => {
      const id = e.layer.options.id;
      selectMaker(id);
    });

    for (const rec of data) {
      const { id, name, lng, lat } = getInfo(rec);
      // If the record is in the middle of geocoding, skip it.
      if (String(lng) === "...") {
        continue;
      }
      if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) {
        // Stuff at 0,0 usually indicates bad imports/geocoding.
        continue;
      }
      const pt = new L.LatLng(lat, lng);
      points.push(pt);

      const marker = L.marker(pt, {
        title: name,
        id: id,
        icon: id == selectedRowId ? selectedIcon : defaultIcon,
        pane: id == selectedRowId ? "selectedMarker" : "otherMarkers",
      });

      const popupHtml = buildPopupContent(name, rawRecordsById[id], mappings);
      marker.bindPopup(popupHtml);
      markers.addLayer(marker);

      popups[id] = marker;
    }
    map.addLayer(markers);

    clearMarkers = () => map.removeLayer(markers);
  }

  // Fetch and add additional layers from other tables
  fetchAdditionalLayers().then(async (additionalLayers) => {
    const additionalLayerGroups = {};

    if (additionalLayers.length > 0) {
      // Sort by order (lower = drawn first = behind)
      additionalLayers.sort((a, b) => a.order - b.order);

      for (const layerConfig of additionalLayers) {
        const group = L.featureGroup();
        for (const feat of layerConfig.features) {
          const featLayer = L.geoJSON(feat.geojson, {
            interactive: layerConfig.interactive,
            style: Object.assign({ opacity: 0.5, fillOpacity: 0.3 }, feat.style),
            onEachFeature: function (_feature, layer) {
              if (layerConfig.interactive && feat.name) {
                layer.bindPopup(DOMPurify.sanitize(String(feat.name)));
              }
            },
          });
          group.addLayer(featLayer);
          points.push(...extractPointsFromGeoJSON(feat.geojson));
        }
        map.addLayer(group);
        additionalLayerGroups[layerConfig.layerName] = group;
      }

      // Re-fit bounds with additional points (only on first load)
      if (isFirstLoad) {
        try {
          map.fitBounds(new L.LatLngBounds(points), {maxZoom: 20, padding: [0, 0]});
        } catch (err) {
          console.warn('cannot fit bounds');
        }
      }
    }

    // Resolve the display label for the Layer column group name
    let layerGroupName = 'Layers';
    if (isLayerMode && mappings && mappings[Layer]) {
      layerGroupName = await getColumnLabel(String(mappings[Layer]));
    }

    addLayerControl(map, mainLayerGroups, additionalLayerGroups, isLayerMode, layerGroupName);
  }).catch((err) => {
    console.error("Error loading additional layers:", err);
    addLayerControl(map, mainLayerGroups, {}, isLayerMode, 'Layers');
  });

  // Restore previous view if available, otherwise fit to data bounds
  if (!isFirstLoad) {
    map.setView(savedMapView.center, savedMapView.zoom);
  } else {
    try {
      map.fitBounds(new L.LatLngBounds(points), {maxZoom: 20, padding: [0, 0]});
    } catch (err) {
      console.warn('cannot fit bounds');
    }
  }
  function makeSureSelectedMarkerIsShown() {
    const rowId = selectedRowId;

    if (rowId && popups[rowId]) {
      const item = popups[rowId];
      if (isGeoJSONMode) {
        // For GeoJSON, open popup on the layer
        item.openPopup();
      } else {
        // For markers
        if (!item._icon) {
          markers.zoomToShowLayer(item);
        }
        item.openPopup();
      }
    }
  }

  amap = map;

  makeSureSelectedMarkerIsShown();
}


function clearPopupMarker() {
  const marker = popups[selectedRowId];
  if (marker) {
    marker.closePopup();
    if (marker.setIcon) {
      // It's a marker
      marker.setIcon(defaultIcon);
      marker.pane = "otherMarkers";
    } else {
      // It's a GeoJSON layer
      const prevStyle = geoJSONStyles[selectedRowId] || {};
      marker.setStyle(Object.assign({
        opacity: 0.3,
        fillOpacity: 0.3,
      }, prevStyle));
    }
  }
}

function selectMaker(id) {
   // Reset the options from the previously selected marker.
   const previouslyClicked = popups[selectedRowId];
   if (previouslyClicked) {
     previouslyClicked.setIcon(defaultIcon);
     previouslyClicked.pane = 'otherMarkers';
   }
   const marker = popups[id];
   if (!marker) { return null; }

   // Remember the new selected marker.
   selectedRowId = id;

   // Set the options for the newly selected marker.
   marker.setIcon(selectedIcon);
   marker.pane = 'selectedMarker';

   // Rerender markers in this cluster
   markers.refreshClusters();

   // Update the selected row in Grist.
   grist.setCursorPos?.({rowId: id}).catch(() => {});

   return marker;
}

function selectGeoJSONFeature(id) {
  // Reset opacity for previously selected feature
  const previouslyClicked = geoJSONLayers[selectedRowId];
  if (previouslyClicked) {
    const prevStyle = geoJSONStyles[selectedRowId] || {};
    previouslyClicked.setStyle(Object.assign({
      opacity: 0.3,
      fillOpacity: 0.3,
    }, prevStyle));
    previouslyClicked.eachLayer(function (layer) {
      if (layer.setIcon) {
        layer.setIcon(defaultIcon);
      }
    });
  }

  const layer = geoJSONLayers[id];
  if (!layer) {
    return null;
  }

  // Remember the new selected feature
  selectedRowId = id;

  // Set style for newly selected feature
  const newStyle = geoJSONStyles[id] || {};
  layer.setStyle(Object.assign({
    opacity: 0.6,
    fillOpacity: 0.6,
  }, newStyle));
  layer.eachLayer(function (l) {
    if (l.setIcon) {
      l.setIcon(selectedIcon);
    }
  });

  // Update the selected row in Grist
  grist.setCursorPos?.({ rowId: id }).catch(() => {});

  return layer;
}

grist.on('message', (e) => {
  if (e.tableId) { selectedTableId = e.tableId; }
});

function hasCol(col, anything) {
  return anything && typeof anything === 'object' && col in anything;
}

function defaultMapping(record, mappings) {
  if (!mappings) {
    return {
      [Longitude]: Longitude,
      [Name]: Name,
      [Latitude]: Latitude,
      [GeoJSON]: hasCol(GeoJSON, record) ? GeoJSON : null,
      [Address]: hasCol(Address, record) ? Address : null,
      [GeocodedAddress]: hasCol(GeocodedAddress, record) ? GeocodedAddress : null,
      [Geocode]: hasCol(Geocode, record) ? Geocode : null,
      [Style]: hasCol(Style, record) ? Style : null,
      [Layer]: hasCol(Layer, record) ? Layer : null,
      [Popup]: hasCol(Popup, record) ? Popup : null,
      [Label]: hasCol(Label, record) ? Label : null,
      [LabelStyle]: hasCol(LabelStyle, record) ? LabelStyle : null,
    };
  }
  return mappings;
}

function selectOnMap(rec, mappings) {
  // If this is already selected row, do nothing (to avoid flickering)
  if (selectedRowId === rec.id) { return; }

  selectedRowId = rec.id;
  if (mode === "single") {
    updateMap([rec], mappings);
  } else {
    updateMap(null, mappings);
  }
}

grist.onRecord((record, mappings) => {
  rawRecordsById[record.id] = record;
  if (mode === 'single') {
    // If mappings are not done, we will assume that table has correct columns.
    // This is done to support existing widgets which where configured by
    // renaming column names.
    lastRecord = grist.mapColumnNames(record) || record;
    selectOnMap(lastRecord, mappings);
    scanOnNeed(defaultMapping(record, mappings));
  } else {
    const isGeoJSONMode = mappings && GeoJSON in mappings && mappings[GeoJSON];
    if (isGeoJSONMode) {
      const feature = selectGeoJSONFeature(record.id);
      if (!feature) {
        return;
      }
      feature.openPopup();
    } else {
      const marker = selectMaker(record.id);
      if (!marker) {
        return;
      }
      markers.zoomToShowLayer(marker);
      marker.openPopup();
    }
  }
});
grist.onRecords((data, mappings) => {
  rawRecordsById = {};
  for (const rec of data) { rawRecordsById[rec.id] = rec; }
  lastRecords = grist.mapColumnNames(data) || data;
  if (mode !== 'single') {
    // If mappings are not done, we will assume that table has correct columns.
    // This is done to support existing widgets which where configured by
    // renaming column names.
    updateMap(lastRecords, mappings);
    if (lastRecord) {
      selectOnMap(lastRecord, mappings);
    }
    // We need to mimic the mappings for old widgets
    scanOnNeed(defaultMapping(data[0], mappings));
  }
});

grist.onNewRecord(() => {
  if (mode === 'single') {
    clearMarkers();
    clearGeoJSONLayers();
    clearMarkers = () => {};
    clearGeoJSONLayers = () => {};
  } else {
    clearPopupMarker();
  }
  selectedRowId = null;
})

function updateMode(mappings) {
  if (mode === "single") {
    if (lastRecord) {
      selectedRowId = lastRecord.id;
      updateMap([lastRecord], mappings);
    }
  } else {
    updateMap(lastRecords, mappings);
  }
}

function onEditOptions() {
  const popup = document.getElementById("settings");
  popup.style.display = 'block';
  const btnClose = document.getElementById("btnClose");
  btnClose.onclick = () => popup.style.display = 'none';
  const checkbox = document.getElementById('cbxMode');
  checkbox.checked = mode === 'multi' ? true : false;
  checkbox.onchange = async (e) => {
    const newMode = e.target.checked ? 'multi' : 'single';
    if (newMode != mode) {
      mode = newMode;
      await grist.setOption('mode', mode);
      updateMode();
    }
  }
  [ "mapSource", "mapCopyright" ].forEach((opt) => {
    const ipt = document.getElementById(opt)
    ipt.onchange = async (e) => {
      await grist.setOption(opt, e.target.value);
    }
  })
  const layersTextarea = document.getElementById('additionalLayers');
  layersTextarea.value = additionalLayersConfig.length > 0
    ? JSON.stringify(additionalLayersConfig, null, 2) : '';
  layersTextarea.onchange = async (e) => {
    await grist.setOption('additionalLayers', e.target.value);
  };
}

const optional = true;
grist.ready({
  columns: [
    "Name",
    { name: "Longitude", type: "Numeric", optional },
    { name: "Latitude", type: "Numeric", optional },
    {
      name: "GeoJSON",
      type: "Text",
      optional,
      description:
        "`geometry` attribute of geojson data. If set, `Longitude` and `Latitude` will not be used.",
    },
    { name: "Geocode", type: "Bool", title: "Geocode", optional },
    { name: "Address", type: "Text", optional },
    {
      name: "GeocodedAddress",
      type: "Text",
      title: "Geocoded Address",
      optional,
    },
    {
      name: "Style",
      type: "Text",
      title: "Style",
      optional,
      description: "JSON style for GeoJSON features. Supports Leaflet path options: color, fillColor, weight, opacity, fillOpacity, dashArray, etc.",
    },
    {
      name: "Layer",
      type: "Text",
      title: "Layer",
      optional,
      description: "Layer name to group features. Each unique value creates a toggleable overlay on the map.",
    },
    {
      name: "Popup",
      type: "Any",
      title: "Popup",
      optional,
      allowMultiple: true,
      description: "Columns to display in the popup when clicking a feature.",
    },
    {
      name: "Label",
      type: "Text",
      title: "Label",
      optional,
      description: "Permanent text label displayed on each feature.",
    },
    {
      name: "LabelStyle",
      type: "Text",
      title: "Label Style",
      optional,
      description: 'JSON style for labels. Supported properties: bearing (rotation degrees), fontSize (px), color, fontWeight, opacity, dynamicSize (bool), referenceZoom (for dynamic sizing), minZoom, maxZoom.',
    },
  ],
  allowSelectBy: true,
  onEditOptions
});

grist.onOptions((options, interaction) => {
  writeAccess = interaction.accessLevel === 'full';
  const newMode = options?.mode ?? mode;
  mode = newMode;
  if (newMode != mode && lastRecords) {
    updateMode();
  }
  const newSource = options?.mapSource ?? mapSource;
  mapSource = newSource;
  document.getElementById("mapSource").value = mapSource;
  const newCopyright = options?.mapCopyright ?? mapCopyright;
  mapCopyright = newCopyright
  document.getElementById("mapCopyright").value = mapCopyright;
  // Load additional layers config
  const layersJson = options?.additionalLayers;
  if (layersJson) {
    try {
      additionalLayersConfig = JSON.parse(layersJson);
    } catch (e) {
      console.error("Invalid additional layers JSON:", e);
    }
  }
  document.getElementById("additionalLayers").value =
    additionalLayersConfig.length > 0 ? JSON.stringify(additionalLayersConfig, null, 2) : '';
});
