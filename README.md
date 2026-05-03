# Grist Map Widget

A custom [Grist](https://www.getgrist.com/) widget that displays a Leaflet map from data stored in a Grist table. Supports GeoJSON geometries (polygons, lines, points, multipolygons), coordinate-based markers, layer grouping, permanent labels, additional read-only layers from other tables, and interactive drawing/editing of shapes directly on the map.

---

## Setup

1. Add a **Custom Widget** to your Grist document.
2. Point it at the URL where this widget is hosted.
3. Open the **Creator Panel** and map your table columns to the widget fields described below.

---

## Column Mappings

| Widget field | Type | Required | Description |
|---|---|---|---|
| **Name** | Any | Yes | Label shown in popups and marker titles |
| **Longitude** | Numeric | No | Longitude for coordinate mode |
| **Latitude** | Numeric | No | Latitude for coordinate mode |
| **GeoJSON** | Text | No | GeoJSON geometry string. Takes precedence over Longitude/Latitude |
| **Style** | Text | No | JSON style for GeoJSON features (see below) |
| **Layer** | Text | No | Groups features into named, toggleable overlays |
| **Popup** | Any | No | One or more columns to display in the click popup (supports multiple) |
| **Tooltip** | Any | No | One or more columns to display in the hover tooltip (GeoJSON mode only, supports multiple) |
| **Label** | Text | No | Permanent text label displayed on the feature |
| **LabelStyle** | Text | No | JSON style for the label (see below) |
| **Fields to fill on new shape** | Any | No | Columns prompted when a new shape is drawn on the map (supports multiple) |
| **Geocode** | Bool | No | Set to true to trigger geocoding for that row |
| **Address** | Text | No | Address to geocode |
| **GeocodedAddress** | Text | No | Cache field — stores the last geocoded address to avoid redundant lookups |

**Modes:**
- **GeoJSON mode** — activated when the `GeoJSON` column is mapped. Renders polygons, lines, and points from GeoJSON strings.
- **Coordinate mode** — fallback when only `Longitude`/`Latitude` are mapped. Renders clustered markers.

---

## Style JSON (polygon / feature style)

The `Style` column accepts a JSON string with [Leaflet path options](https://leafletjs.com/reference.html#path-option). All properties are optional.

```json
{
  "color": "#ff0000",
  "fillColor": "#ff6666",
  "weight": 2,
  "opacity": 0.8,
  "fillOpacity": 0.4,
  "dashArray": "5, 10"
}
```

| Property | Description | Example |
|---|---|---|
| `color` | Stroke (border) color | `"#ff0000"` |
| `fillColor` | Fill color | `"#ff6666"` |
| `weight` | Stroke width in pixels | `2` |
| `opacity` | Stroke opacity (0–1) | `0.8` |
| `fillOpacity` | Fill opacity (0–1) | `0.4` |
| `dashArray` | Stroke dash pattern | `"5, 10"` |
| `lineCap` | Stroke line cap | `"round"` |
| `lineJoin` | Stroke line join | `"round"` |

---

## Label Style JSON

The `LabelStyle` column accepts a JSON string controlling the permanent label displayed on each feature.

```json
{
  "bearing": 45,
  "fontSize": 14,
  "color": "#333333",
  "fontWeight": "bold",
  "opacity": 0.9,
  "dynamicSize": true,
  "referenceZoom": 18,
  "minZoom": 15,
  "maxZoom": 22
}
```

| Property | Description | Example |
|---|---|---|
| `bearing` | Rotation angle in degrees | `45` |
| `fontSize` | Font size in pixels | `14` |
| `color` | Text color | `"#333333"` |
| `fontWeight` | CSS font-weight | `"bold"`, `"normal"`, `600` |
| `opacity` | Label opacity (0–1) | `0.9` |
| `dynamicSize` | Scale font size with zoom level | `true` |
| `referenceZoom` | Zoom at which `fontSize` is exact (default: 18) | `18` |
| `minZoom` | Hide label below this zoom level | `15` |
| `maxZoom` | Hide label above this zoom level | `22` |

**Dynamic sizing formula:** `displaySize = fontSize × 2^(currentZoom − referenceZoom)`

### Per-part labels on multipolygons

For features with multiple polygon parts (MultiPolygon GeoJSON), `Label` and `LabelStyle` can each be a **JSON array**, with one element per polygon part in order:

```
Label column:      ["North field", "South field"]
LabelStyle column: [{"bearing": 30, "fontSize": 12}, {"bearing": 90, "fontSize": 10}]
```

A single value (non-array) applies the same label or style to all parts.

---

## Layer Grouping

When the `Layer` column is mapped, features are grouped by their `Layer` value into named, toggleable overlays. A layer control appears in the top-right corner of the map.

- Each unique value in the `Layer` column creates a separate overlay.
- The overlays are grouped under a collapsible section named after the `Layer` **column label** (not the column ID).
- Clicking the group checkbox toggles all sub-layers at once.
- Clicking the group name or arrow expands/collapses the list.

---

## Drawing and Editing Shapes

When the **GeoJSON** column is mapped and the widget has write access, a draw toolbar can be enabled from the settings panel. It allows creating, editing, and optionally deleting shapes directly on the map.

### Creating a shape

1. Enable **Show draw toolbar** in the settings panel.
2. Select a draw tool (polygon, rectangle, polyline, or marker).
3. Draw the shape on the map.
4. If **Fields to fill on new shape** columns are mapped, a form appears — fill in any values and click **Save**. Fields left blank are not written.
5. A new record is added to the Grist table with the geometry stored in the `GeoJSON` column.

### Editing a shape

1. Click the pencil (edit) button in the toolbar.
2. Drag vertices to reshape features.
3. Click **Save** — the updated geometry is written back to the `GeoJSON` column of the corresponding record.
4. Click **Cancel** to discard changes.

### Deleting a shape

Enable **Show delete toolbar** in the settings panel to add a trash-can button. Selecting and confirming a deletion removes the record from the Grist table.

> **Note:** Circles are not supported as a draw type — GeoJSON has no native circle geometry. Use polygons or markers instead.

---

## Additional Layers from Other Tables

Read-only GeoJSON layers from other Grist tables can be added via the widget settings panel.

Paste a JSON array into the **Additional layers** field:

```json
[
  {
    "table": "Parcels",
    "layer": "Cadastral parcels",
    "columns": {
      "GeoJSON": "geom",
      "Name": "parcel_id",
      "Style": "style",
      "Label": "label_col",
      "LabelStyle": "label_style_col"
    },
    "order": 0,
    "interactive": true,
    "filter": "is_active"
  },
  {
    "table": "Roads",
    "layer": "Road network",
    "columns": {
      "GeoJSON": "geometry"
    },
    "order": 1,
    "interactive": false,
    "filter": [
      {"col": "status", "op": "==", "val": "open"},
      {"col": "road_class", "op": "!=", "val": "track"}
    ]
  }
]
```

| Property | Required | Description |
|---|---|---|
| `table` | Yes | Grist table ID (visible in the URL or table settings) |
| `layer` | No | Display name in the layer control (defaults to the table ID) |
| `columns.GeoJSON` | Yes | Column ID containing GeoJSON geometry strings |
| `columns.Name` | No | Column ID for popup label when `interactive` is true |
| `columns.Style` | No | Column ID for JSON style (same format as the main `Style` column) |
| `columns.Label` | No | Column ID for permanent text labels |
| `columns.LabelStyle` | No | Column ID for label style JSON |
| `order` | No | Drawing order — lower values are drawn first (behind). Default: `0` |
| `interactive` | No | If `false`, clicks pass through and no popup is shown. Default: `true` |
| `filter` | No | Row filter — see below |

### Filtering rows in additional layers

The `filter` property controls which rows are included. Three forms are accepted:

**Boolean column** — include rows where the column value is truthy:
```json
"filter": "is_active"
```

**Single condition:**
```json
"filter": [{"col": "status", "op": "==", "val": "active"}]
```

**Multiple conditions (all must pass — AND logic):**
```json
"filter": [
  {"col": "status", "op": "==", "val": "active"},
  {"col": "area",   "op": ">",  "val": 100}
]
```

Supported operators: `==` `!=` `>` `>=` `<` `<=` `contains` `startsWith`

---

## Widget Settings

Open the settings panel via the wrench icon:

| Setting | Description |
|---|---|
| **All locations / Single** | Toggle between showing all rows or only the currently selected row |
| **Show print button** | Show a Print button fixed to the bottom-left corner of the map (hidden by default) |
| **Show draw toolbar** | Show the Leaflet.draw toolbar for creating and editing shapes (hidden by default; GeoJSON mode + write access required) |
| **Show delete toolbar** | Add a delete button to the draw toolbar to remove shapes and their Grist records (hidden by default) |
| **Source** | Tile layer URL template (default: OpenStreetMap). See [Leaflet providers](https://leaflet-extras.github.io/leaflet-providers/preview/) for alternatives |
| **Copyright** | Attribution text shown on the map |
| **Additional layers** | JSON config for layers from other tables (see above) |
| **Layer order & default visibility** | JSON object mapping layer names to initial visibility. Also controls draw order (first key = topmost). Example: `{"Layer A": true, "Layer B": false}` |

**Example tile source for high-zoom satellite imagery (ESRI):**
```
https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
```
Attribution: `Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community`

---

## Dependencies

- [Leaflet 1.6.0](https://leafletjs.com/)
- [Leaflet.draw 1.0.4](https://github.com/Leaflet/Leaflet.draw)
- [Leaflet.markercluster 1.5.3](https://github.com/Leaflet/Leaflet.markercluster)
- [Leaflet Control Geocoder 3.1.0](https://github.com/perliedman/leaflet-control-geocoder)
- [DOMPurify 3.2.3](https://github.com/cure53/DOMPurify)
- [Grist Plugin API](https://support.getgrist.com/widget-custom/)
