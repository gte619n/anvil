# Phase A0 spike: SolidCraft 0.44.1 (commit e151d5ea), M4, 2026-11-19

Scripts and artifacts: `/tmp/sc-a0` (`sc.py` client, `holes.py`, `s1.py` to `s8.py`, `timing.py`).

## Verdicts

| # | Assumption | Verdict |
|---|---|---|
| S1 | Two callers can share one process in sequence | **Confirmed.** 11 pipelined requests came back in request order, one complete line each, each reflecting the state left by the previous one. Ids echoed. |
| S2 | Exported script replays to the same numbers | **Confirmed.** Volume 23335.166952407864, sorted bbox [6,50,80], 22 faces, 1 body, identical after replay in a fresh process; re-export byte-identical. |
| S3 | Reference STEP survives script export with a relative path | **Refuted as worded, goal met.** The script records no path: the import feature embeds the whole STEP text. Replay works with `refs/` renamed away. No fallback needed. |
| S4 | Hole table from `body_topology` | **Confirmed with a change.** `body_topology` has no convex/concave flag; concavity comes from `view.pick` rays. Correct on the plate, a boss+blind-hole part, and a stress part. |
| S7 | Headless with no one logged in (M1 over SSH) | **Stand-in only.** Works under `env -i PATH HOME TMPDIR` on the M4. The M1/SSH run is awaiting the owner. `SOLIDCRAFT_GPU=cpu` removes the GPU question. |

## Facts for implementers

### Transport

- **Spawn:** `solidcraft-cli mcp --headless --compact --allow-path <abs dir> --require-allow-path [--in <abs design.json>]`.
- **Framing:** JSON-RPC 2.0, one message per line each way. One reply line can be about 720 KB
  (screenshot base64). Do not cap line length.
- **Handshake:** `initialize` (protocolVersion `"2025-06-18"`) returns
  `{capabilities:{resources:{listChanged:false},tools:{listChanged:false}},instructions,protocolVersion,serverInfo:{name:"solidcraft",title,version:"0.44.1"}}`;
  then send notification `notifications/initialized`. `ping` returns `{}`.
- **Tool call:** `{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":T,"arguments":{...}}}`.
- **Success:** `{"id":N,"jsonrpc":"2.0","result":{"content":[{"text":"<JSON string>","type":"text"}]}}`.
  There is no `isError` key on success.
- **`--compact`:** JSON is not pretty-printed and `inspect_design` sketch summaries shrink; keys
  are otherwise identical.
- **Three error channels:**
  1. Tool or command failure: `result:{content:[{text:"<plain message, NOT JSON>",type:"text"}],isError:true}`.
  2. Bad tool name or tool arguments: a JSON-RPC error, no result.
     `{"error":{"code":-32602,"message":"unknown tool `nope`"},"id":901}`;
     `"measure: unknown argument `bogus`; its arguments are: body, items, names_only, summary"`;
     `"body_topology: missing required argument `body`"`. Unknown method is -32601. Bad JSON is
     `{"error":{"code":-32700,"message":"parse error: ..."},"id":null}` and the server keeps running.
  3. Bad command params inside `execute`: channel 1, e.g. ``invalid parameters for `solid.box`: `width` must be a number or an expression`` or ``unknown command `no.such` ``.
- **Multi-part content:** never assume `content[0]` is the JSON. A failing `batch` is one text
  part holding JSON with `isError:true`. An `expect` mismatch is two text parts (message, then
  JSON) with `isError:true`. `screenshot` and `compare_picture` return an image part plus a text part.
- **Lifecycle:** start to initialize reply 9 to 13 ms. stdin EOF: exit 0 in about 9 ms.
  `--in` with a missing file: exit 1, stderr `error: <path>: No such file or directory (os error 2)`.
  stderr at start prints the allowed folders.
- `describe_command` takes `{id}`, not `name`. `list_commands {}` unfiltered is 393 KB.
- `version {}` returns `{"commit":"e151d5ea...","mode":"headless","version":"0.44.1"}`.

### batch

Args: `{commands:[{command,params}], verbose?:false, expect?, coalesce_parameters?, rollback?, path?}`.

- **Success:** `{"completed":16,"ok":true,"results":[...one per step...]}`.
  - Feature step: `{"changed_bodies":[],"created_bodies":["Body1"],"feature":2,"ms":6.5,"name":"Plate","removed_bodies":[],"warning":null}`.
  - `parameters.add` step: `{"display_value":80.0,"name":"L","unit":"mm","value":80.0}`.
- **Failure (`isError:true`):** `{"applied":[],"completed":8,"failed":{"command":"solid.fillet","error":"...","index":8},"not_run":[9],"ok":false,"results":[...],"rolled_back":true,"undone":8}`.
  The design is back to its pre-batch state.
- **Expect mismatch (`isError:true`, design kept):** part 1 a message, part 2 JSON with
  `expectation:{expected,measured,mismatch,ok:false}`.
- A body made by extrude is named `Body1`; `name:"Plate"` names the feature, not the body.
- **Undo: a batch is NOT one undo step.** The 16-command plate batch adds 14 undo steps. Each
  `undo` removes one sub-command, and a partial undo can re-open a sketch (`active_sketch: 4`).
  `execute`, `set_parameter` and `file.insert_step` are one step each.

### execute timeline.export_script

Request: `{"command":"timeline.export_script","params":{}}` or `{"path":"<abs>"}`. Reply either way:
`{"omitted":[],"path":null|"<abs>","script":{"about":{"design":"Untitled","format":"solidcraft/58","replay":"...","version":"0.44.1"},"commands":[{"command":"parameters.add","params":{"expression":"80 mm","name":"L","unit":"mm"}},...,{"command":"timeline.add","params":{"feature":{...}}}]},"steps":10}`

- Deterministic: identical state gives byte-identical output, including after replay in a new process.
- 0.4 to 5 ms. The plate is 4 `parameters.add` plus 6 `timeline.add`; sketch commands collapse
  into features.
- Works on an empty design (`commands:[]`), with an active sketch, with failing features (no
  error raised), with an imported STEP, and with a component.
- `about.design` follows the design name ("Untitled" by default; `save p.sc` renames it to "p").
  `about.version` is the build that wrote it. **`about.format` is not enforced on replay.**

### Replay

- **In the manager:** `mcp ... --in <design.json>`. Spawn + initialize + first measure is 250 to
  340 ms. **It starts even when features fail.** Leaves one undo step per script step.
- **In a live process:** `batch {commands: script.commands}` also works; a `timeline.add` step
  result is `{"error":null,"feature":1,"name":"PlateSketch","warning":null}`, and the batch is
  `ok:true` even if `error` is set.
- **`solidcraft-cli eval design.json [--json-out F]`** prints measure's keys plus `params`,
  `sketches`, `timeline:[{error,id,ms,name,rolled_back,suppressed,type,warning}]`. **Exits 0
  even when features fail**; read `timeline[].error`.
- **`solidcraft-cli run design.json --quiet`** exits 1 on failed features. `run design.json
  --save x.sc --out x.step` builds files without a live process.
- **MCP `open` refuses a command script** (``design file: missing field `name` ``). Use `--in`.

### measure

Args: `{body?, items?, names_only?, summary?}`. Full reply:
`{"bodies":[{"area_mm2":9777.849501661702,"bbox":{"max":[40.0,25.0,6.000000000000001],"min":[-40.0,-25.0,0.0]},"center_of_mass":[x,y,z],"closed":true,"density_g_cm3":1.29,"edges":48,"face_types":{"cylinder":12,"plane":10},"faces":22,"kernel":{"edges":48,"faces":22,"shells":1,"vertices":32},"mass_g":30.1,"material":"Default","measured_by":"smlib","name":"Body1","notes":[],"vertices":32,"volume_mm3":23335.166952407864}],"body_count":1,"total":{"area_mm2":..,"edges":48,"faces":22,"mass_g":..,"open_bodies_skipped":0,"vertices":32,"volume_mm3":23335.166952407864}}`

- Logical face count is `bodies[i].faces` and `total.faces`; kernel count is `bodies[i].kernel.faces`.
- `summary:true`: `{"bodies":[{"bbox":{max,min},"closed":true,"faces":22,"name":"Body1","volume_mm3":..}],"body_count":1,"total":{"volume_mm3":..}}`.
- `body:"Body2"` restricts to that body. For several bodies use `execute inspect.measure {bodies:[...]}`.
- **Totals include imported reference bodies.**
- Empty design: `body_count:0`, `total.volume_mm3:-0.0`.
- `bbox` is `{min,max}` on world axes, unsorted, with float dust.
- **A design with failed features still measures, silently, the partial geometry.**

### inspect_design

Args: `{measure?, sketches?, bodies?: true|"names"|false|[names], timeline?: true|"summary"|false, joints?}`.
Keys: `active_sketch, bodies, dirty, hidden_origin, marker, metadata, name, params, path, redo, revision, selection, sketches, timeline, undo, units`.

- `params`: `[{"comment":"","error":null,"expression":"80 mm","model":false,"name":"L","unit":"mm","value":80.0}]`.
  `model:false` is a user parameter; `model:true` is a sketch-dimension or feature parameter.
- `timeline` full: `{"error":null,"id":2,"ms":1.458,"name":"Plate","rolled_back":false,"suppressed":false,"type":"ExtrudeFeature","warning":null}`.
  `"summary"`: `{"id","name","type"}` plus `error`, `warning`, `suppressed`, `rolled_back` only
  when set. Types seen: Sketch, ExtrudeFeature, FilletFeature, HoleFeature,
  RectangularPatternFeature, BoxFeature, CylinderFeature, **BaseFeature (STEP import)**.
- `bodies` with `measure:false`: `[{"feature":2,"name":"Body1","visible":true}]` (`feature` is the
  creating feature id; an import body points at the BaseFeature). `"names"`: `["Body1"]`.
- `undo` and `redo` are stack depths. `revision` increases on every change.
- Recommended post-step read: `{measure:false,sketches:false,timeline:"summary",bodies:"names"}`
  (2.2 KB, 0.5 ms). Use `bodies:true`-with-`measure:false` form when the creating feature is needed.

### Feature warnings and errors

- Errors appear in `timeline[].error`; in the `set_parameter` reply `errors:[{"error":"...","feature":"Corners"}]`;
  in `check_parameters` `errors:[{"error","feature":3,"name":"Corners"}]`.
- Warnings appear in a feature result's `warning`, `timeline[].warning`, `check_parameters.warnings[]`.
- A "Boolean retry" warning could not be reproduced on 0.44.1 in 13 constructions. Its documented
  form is `Boolean retry: temporary coincident-face separation up to 2.050000e0 mm per face`.
  Only the fake server can exercise that path.

### set_parameter / parameters.change / check_parameters

- `set_parameter {name, value|expression, unit?, comment?}` returns
  `{"display_value":120.0,"errors":[],"expression":"120","name":"L","recomputed":6,"restored":0,"value":120.0}`. One undo step.
- **It creates the parameter when the name is unknown.** So does `execute parameters.change {name, expression}`.
- Only `execute parameters.change {changes:{name:expr}}` refuses an unknown name
  (isError ``unknown parameter `Nope2` ``; all-or-nothing, one rebuild).
- Bad expression: isError ``expression: unknown parameter `nope` ``; nothing changes.
- **A value that breaks features is a success reply with `errors` filled, and the change is kept.**
- `check_parameters {set:{L:"120",W:60}, report?:["measure","cylinders","errors"], summary?, bodies?}`
  returns `{"cylinders":[…],"errors":[],"measure":{…},"parameter_errors":[],"recomputed":6,"restored":true,"set":{...},"values":{"L":120.0,"W":60.0},"warnings":[]}`;
  design and undo depth unchanged afterwards.
- `execute parameters.list {filter:"user"}` returns `{"count","cycles":[],"parameters":[{comment,display_value,error,expression,favorite,name,source:"user",unit,used_by,uses,value}]}`.

### undo / redo / checkpoints

- `undo {}` returns `{"undone":"Change Parameters"}`; `redo {}` returns `{"redone":"..."}`. Empty
  stack: isError "nothing to undo" / "nothing to redo".
- `execute edit.checkpoint {}` returns `{"checkpoint":3}`; `execute edit.restore_checkpoint {checkpoint:3}`
  returns `{"checkpoint":3,"restored":true}`. Only the last 16 are kept and a restore consumes it
  and every later one.

### inspect.interference

Request: `execute {command:"inspect.interference", params:{bodies?:[names]|null, budget_s?, exclude_pairs?:[[a,b]]}}`.

- Overlap: `{"budget_exceeded":false,"checked":2,"count":1,"interferences":[{"a":"Body1","b":"box","volume_mm3":125.66,"bbox":{…},"center":[…],…}],"truncated":false,"unchecked":[],…}`.
- Clear: same keys with `count:0, interferences:[]`.
- Unknown body: isError ``invalid parameters for `inspect.interference`: no body `Zed` ``.
- "No interference" requires `count==0 && unchecked==[] && !budget_exceeded && !truncated`.

### file.insert_step (reference import)

Request: `execute {command:"file.insert_step", params:{path, name?, flatten?, up?, matrix?}}`. Reply:
`{"bodies":["box"],"component":7,"component_name":"ref-box","content_sha256":"1838...","created_bodies":["box"],"feature":9,"name":"ref-box","occurrence":8,"path":"...","warnings":[]}`

- `name` names the feature and component, not the body. The body name comes from the file
  ("box"); a second insert gives "box (2)". Read names from `created_bodies`.
- Timeline entry type is `BaseFeature`.
- In the script: `component.create`, `occurrence.ground`, `occurrence.move`, `occurrence.ground`,
  `component.metadata.set`, then `timeline.add` with `feature.type:"import"`,
  `feature.file:"<basename>"`, `feature.step:"<full STEP text>"`.
  `sha256(feature.step) == sha256(file) == content_sha256`.

### body_topology and the hole table

- `body_topology {body, faces?: "all"|"cylinders"}`. Unknown body: isError.
- **all:** `{"body","edges":[{"end","index","length","mid","name","start"}],"faces":[{"area","centroid","exact","index","name","plane_normal":[..]|null,"point","cylinder"?:{"axis","origin","radius"}}]}` (16 KB compact for the plate).
- **cylinders:** `{"body","cylinders":[{"axis":[0,0,1],"extent":[0.0,6.0],"names":["F5:cbore:side:0"],"origin":[32,17,2.7],"radius":3.2499999999999987}]}` (2 KB). Split halves are merged. `extent` is [min,max] along `axis` from `origin`.
- **`execute view.pick {rays:[{origin,dir}] (max 1024), all:true}`** returns
  `{"frame":"rays","hits":[[{"body":"Body1","depth":2.5,"face":9,"normal":[-1,0,0],"point":[32.5,15,7]}], [], ...]}`:
  one list per ray, nearest first, `[]` for a miss. `normal` is the outward normal.

```
hole_table(body):
  cyls = body_topology{body, faces:"cylinders"}.cylinders
  for c in cyls:                          # a = unit(c.axis); e0,e1 = c.extent
    for station t in (1/6, 1/2, 5/6):     # 3 stations survive cross-drilling
      S = c.origin + a*(e0 + (e1-e0)*t)
      8 rays from S, directions u_k perpendicular to a at 11deg + 45deg*k
    M = c.origin + a*(e0+e1)/2 ; rays (M,+a) and (M,-a)        # 26 rays per cylinder
  hits = view.pick{rays, all:true}        # chunks of <=1014 rays
  for c:
    concave(station) = count of k where the first hit h with h.body==body has
                       |h.depth - c.radius| < 1e-3*max(1,r)  and  dot(h.normal, u_k) < -0.99
    is_hole = max over stations >= 6      # boss 0/8, fillet 2/8, slot end 4/8
    closed_plus/minus = first same-body hit along +a/-a exists with depth <= (e1-e0)/2 + 1e-3
  stacks = group is_hole cylinders that are coaxial (|dot(a1,a2)|=1, perpendicular offset < 1e-3)
  for stack (sorted by radius): n = smallest
    hole = {diameter: round(2*n.radius,4),
            kind: (!n.closed_plus && !n.closed_minus) ? "through" : "blind",
            depth: sum of section lengths,
            counterbore?: [{diameter, depth} for the larger sections]}
  table = holes grouped by identical record, with count; sorted by diameter
```

Plate result: `[{"diameter":3.4,"kind":"through","depth":6.0,"counterbore":[{"diameter":6.5,"depth":3.3}],"count":4}]`.
A counterbore is not a separate row. Countersinks and slots are not holes. Takes 100 to 157 ms.

### export

`export {path, format?, bodies?}`. Formats: step, stp, iges, igs, 3mf, 3mf-tagged, stl, stla,
obj, glb, urdf. Reply `{"bytes":64252,"format":"Glb","path":"<abs>"}`. Format from the extension
unless given. Empty design or unknown body: isError "nothing to export: the design has no
bodies". GLB is in metres with Y up.

### screenshot / compare_picture

- `screenshot {source?:"model", width?:960, height?:600, view?, camera?:{target,yaw,pitch,distance,fov?}, grid?, axes?, path?}`
  returns `[{"data":"<base64>","mimeType":"image/png","type":"image"},{"text":"{\"bytes\":206218,\"height\":420,\"path\":null,\"renderer\":\"gpu\",\"source\":\"model\",\"width\":640}","type":"text"}]`.
  The CPU renderer adds a `warning` key.
- `compare_picture {reference:<abs path in sandbox>, view?:"front", camera?, bodies?, crop_px?, crop_fraction?, fit?, rows?}`
  returns an overlay image part plus text `{"aspect_mismatch":0.9929,"overlap":0.9927,"edges":{…},"mm_per_px":{…},"model":{…},"picture":{…}}`.

### new_design / open / save

- `new_design {name?}` returns `{"name":"plate"}` and discards the current design.
- `open {path}`: `.sc` or design `.json` gives `{"errors":0,"features":6,"name":"plate","path":"..."}`;
  a command script is refused; a missing file is isError.
- `save {path?, format?}` returns `{"bytes":39915,"name":"plate","path":"..."}`. **Saving renames
  the design to the file stem** and leaves `<file>.bak` on overwrite.

### Sandbox

- Allowed: every `--allow-path`; `~/Library/Application Support/SolidCraft/recovery`; a
  per-process `$TMPDIR/solidcraft-mcp-<pid>-<hex>`; folders of designs opened or saved in the session.
- Outside them, reads and writes return isError and write nothing:
  ``<path>: <path>: outside the folders this agent may use (<list>); allow another folder with `--allow-path DIR` ``.
- Also refused: a symlink inside the allowed folder pointing out; `..` traversal; a relative path
  when cwd is outside the allowed folders.
- `--require-allow-path`: exit 1 at start when every `--allow-path` folder is missing.

### Timing (median of 5, M4)

| Step | ms |
|---|---|
| process start to initialize reply | 11 |
| 16-command plate batch | 237 |
| export_script inline | 2.3 |
| measure first / repeat | 64 / 0.4 |
| inspect_design light | 0.5 |
| body_topology all / cylinders | 31 / 9 |
| hole table | 126 |
| GLB export / STEP export | 30 / 2.6 |
| set_parameter L=120 | 217 |
| screenshot first gpu / later / first cpu | 5598 / 10 / 34 |
| cold restart: spawn `--in` + initialize + measure | 318 |

## Spec changes that follow

1. References travel inside `design.json` (embedded STEP). Cap reference size; detect a changed
   `refs/x.step` by comparing its sha256 with the import feature's `step` sha256.
2. Measure design bodies only (exclude bodies whose creating feature is a `BaseFeature`).
3. Add a hard gate check: no timeline feature has `error`.
4. `undo`/`redo` must revert one agent request: keep a stack of `inspect_design.undo` depths.
5. Route parameter edits through `parameters.change {changes:{…}}`, which refuses unknown names.
6. Hole table uses `body_topology {faces:"cylinders"}` plus `view.pick`.
7. Start with `SOLIDCRAFT_GPU=cpu`, `--in design.json`, `--require-allow-path`, absolute paths;
   check timeline errors after start.
8. `scriptSha` hashes canonical `commands` only. Never call `save` or `open` in the live process.
9. `about.format` is not enforced by SolidCraft; any format gate must be the daemon's own.
