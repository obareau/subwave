// Thin react-hook-form + zod wiring, written once rather than in each admin
// form that binds one.
//
// `useZodForm` + `fieldAria` here, the five bound field components
// (TextField/TextareaField/SelectField/SwitchField/ToggleGroupField) in the
// sibling lib/form-fields.tsx — together these are what every converted
// ENTITY EDITOR binds through: TakeoverCard, the Festivals/Moods/Skills/
// Blocklist editors, the seven imaging create/import modals, the onboarding
// wizard, Personas (+ its persona/prompt card files), Shows, Playlist
// Builder, Webhooks, Stations. 23 `useZodForm(` call sites as of this
// writing (`grep -rn 'useZodForm(' web --include=*.tsx | wc -l`).
//
// The nine `settings/` sections (Station, TTS, LLM, Embedding, Requests,
// Privacy, Search, Scrobble, Imaging toggles, …) are DELIBERATELY NOT bound
// here — see CLAUDE.md's "Shared form schemas (zod)" bullet for why: there is
// no single submit to bind (`SaveBar` commits one setting at a time, so each
// panel needs its own per-field save/dirty machinery, not one form-wide
// handleSubmit) and `SettingsPanel` owns a hydrate-once lifecycle across all
// nine that a per-panel `useZodForm` would have to duplicate or fight.
//
// The schemas come from lib/schemas.generated.ts — the committed mirror of
// controller/src/schemas/**, kept honest by a CI drift check. So the rules this
// resolver enforces are byte-for-byte the rules the controller enforces.
//
// Note there is deliberately no ui/form.tsx: shadcn's Field primitives are
// already vendored at components/ui/field.tsx, and FieldError already accepts
// react-hook-form's { message } error shape.
//
// PITFALL — a field registered here that ISN'T a key of the bound schema is
// SILENTLY DROPPED, not a type error: `handleSubmit`'s callback receives the
// resolver's PARSED OUTPUT (z.output<S>), and z.object() strips any key it
// doesn't declare. `useZodForm`'s `z.input<S>`/`z.output<S>` generics (below)
// make the compiler see the real output TYPE, but the compiler cannot see a
// field that was never part of the schema's shape at all — `form.register`/
// `useController`/a bound component all happily accept any string as `name`.
// This shipped live once (PlaylistBuilderPanel's `saveMode`, task-11-report.md
// / task-12-report.md Fix round 1): every "Overwrite existing" save read
// `values.saveMode` as `undefined` and created a duplicate playlist instead of
// updating. The two safe patterns, both used elsewhere in this codebase: (1)
// every field the form registers is a real key of the bound schema (verify by
// diffing registered names against the schema's declared object shape — see
// task-12-report.md's per-form audit for the method), or (2) a field that
// deliberately isn't part of the wire schema (a local UI-only choice like
// `saveMode`, a `File` a zod-only schema can't describe) is read off
// `form.getValues('thatField')` / `useWatch({control, name: 'thatField'})`
// instead of off `handleSubmit`'s parsed `values` — both bypass the resolver
// and return exactly what's registered. A form that never calls
// `handleSubmit` at all (MoodsPanel/PersonasPanel/ShowsPanel — they build
// their POST body from `getValues()` instead) cannot exhibit this by
// construction, whichever pattern its fields use.
//
// `useZodForm` now also runs a DEV-ONLY runtime probe for pattern (1) —
// see "Dev-only phantom-field probe" below `useZodForm`'s own definition for
// the mechanism (why a parse-and-diff check would miss the forms most likely
// to be wrong, and why the warning only fires on a literal `values.thatField`
// read rather than on the defaultValues/schema mismatch alone, which pattern
// (2) produces just as legitimately). It cannot see call-site source, so it
// stays silent wherever it can't prove a key is both dropped AND read off the
// parsed values — task-14-report.md has the full false-positive audit.
import { zodResolver } from '@hookform/resolvers/zod';
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from 'react-hook-form';
// Value import, not type-only: the phantom-field probe below does a runtime
// `instanceof z.ZodObject` check. Zod is already a runtime dependency of
// every schema this file is handed, so this adds no new weight.
import { z } from 'zod';

// All THREE generics are passed on purpose.
//
// react-hook-form is useForm<TFieldValues, TContext, TTransformedValues>, and
// handleSubmit's callback receives TTransformedValues — which is what
// zodResolver actually hands it at runtime, i.e. z.output<S>. Passing only
// z.input<S> lets TTransformedValues silently default to the INPUT type. That
// is harmless while a schema's output is a superset of its input (webhooks),
// but the first type-CHANGING transform — z.coerce.number(),
// z.string().transform(Number), an object-reshaping .transform() — would type
// `values.x` as string while it is really a number, with no error anywhere.
// The middle generic is TContext, which nothing here uses; `unknown` rather
// than react-hook-form's `any` default.
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues: DefaultValues<z.input<S>>,
): UseFormReturn<z.input<S>, unknown, z.output<S>> {
  const form = useForm<z.input<S>, unknown, z.output<S>>({
    // A cast is unavoidable here: inside this function TS only knows S by its
    // constraint, so it collapses z.input<S>/z.output<S> to plain FieldValues
    // and zodResolver comes back as Resolver<FieldValues, unknown, FieldValues>.
    // The assertion is deliberately on the SCHEMA, not on the resolver: it
    // states only the tautology that S is a ZodType carrying S's own input and
    // output types, and lets the Resolver type stay DERIVED from
    // @hookform/resolvers' own signature — so if that signature changes, this
    // follows it instead of overriding it. Nothing about runtime changes;
    // zodResolver(schema) is still exactly what is called.
    resolver: zodResolver(schema as unknown as z.ZodType<z.output<S>, z.input<S>>),
    defaultValues,
    // Validate as the operator types, so the Save button's disabled state
    // tracks validity without a submit attempt — matching the behaviour the
    // hand-rolled `valid()` predicate used to provide.
    mode: 'onChange',
  });

  // No hook call inside this branch (see the section below) — just a plain
  // function call, so there's nothing here for react-hooks/rules-of-hooks to
  // flag, and `process.env.NODE_ENV` is a build-time constant Next.js inlines
  // and strips in a production bundle, taking this whole call with it.
  if (process.env.NODE_ENV !== 'production') {
    installPhantomFieldProbe(form, schema, defaultValues);
  }

  return form;
}

// ---------------------------------------------------------------------------
// Dev-only phantom-field probe (see the PITFALL comment above).
//
// An ESLint rule was considered and rejected: several bound schemas here have
// no object SHAPE to introspect statically (`festivalsSchema` is
// `z.unknown().superRefine(...).transform(...)` — the stripping happens
// inside a hand-written transform, not a `z.object`), some are runtime
// factories that don't exist until called with context (`showSchema(ctx)`),
// and `playlistSaveSchema` hides its shape behind a `z.preprocess(...)`
// wrapper. None of that is visible to a lint pass. This is a runtime probe
// instead, gated on `process.env.NODE_ENV !== 'production'` — the same gate
// `components/ServiceWorkerRegister.tsx` uses — which Next's build inlines to
// the literal `"production"` and strips as dead code, so it costs nothing in
// a prod bundle: no extra render work, no extra bytes.
//
// Two parts, because a parse-and-diff probe (parse `defaultValues` through
// the schema, diff the input keys against whatever keys survive) is SILENT
// on exactly the forms most likely to be wrong: a fresh row's defaultValues
// are deliberately seeded blank — an empty required `name`, say — so the
// parse fails before there's an output to diff against at all. That's
// PlaylistBuilderPanel's SaveFormValues in one sentence (`name: ''` fails
// `.min(1, 'name is required')`), which is exactly the form this needs to
// catch.
//
//   1. STRUCTURAL, at mount (`declaredTopLevelKeys` below): unwrap the schema
//      — through ZodOptional/ZodNullable/ZodDefault/ZodReadonly/
//      ZodNonOptional/ZodPrefault's `innerType`, and a ZodPipe's `.out`
//      (covers `z.preprocess(fn, obj)`; `.check()`/`.superRefine()` on an
//      object need no unwrapping at all, since they keep `def.type ===
//      'object'`) — down to the outermost ZodObject governing the form's
//      TOP-LEVEL keys. `z.object()` strips any key outside its declared
//      `.shape` UNCONDITIONALLY, whether or not the rest of the value would
//      parse, so this needs no successful parse and is never wrong when it
//      resolves. When no ZodObject is reachable — a bare transform/effect as
//      the whole bound schema, or one with `.passthrough()`/`.catchall()`
//      where nothing is actually dropped — it gives up rather than guess.
//      Only the OUTERMOST object ever needs unwrapping: a factory's own
//      internals (`showSchema(ctx)`, `festivalsSchema(ctx)`) don't need
//      resolving, because `defaultValues`' keys are checked at the same top
//      level the object's own `.shape` is declared at.
//   2. ACCESS-TRACKING, at submit (`wrapWithPhantomFieldWarnings` below):
//      knowing step 1's key is dropped doesn't mean reading it is a bug —
//      pattern (2) in the PITFALL comment (`saveMode` today, read via
//      `getValues`/`useWatch`) produces the IDENTICAL defaultValues/schema
//      mismatch and is fully supported. The two are NOT distinguishable from
//      defaultValues and the schema alone — proven by this codebase's own
//      history: the commit that shipped the bug and the commit that fixed it
//      pass `useZodForm` the exact same schema and the exact same
//      defaultValues; only the `handleSubmit` callback's BODY differs
//      (`values.saveMode` vs `saveForm.getValues('saveMode')`), and that body
//      is application code this file never sees. So step 1's "phantom" set
//      only arms a wrapped `handleSubmit`: the `values` object handed to the
//      caller's `onValid` becomes a Proxy that warns the first time
//      application code reads one of those keys BY NAME. `getValues()`/
//      `useWatch()` never touch this object at all — they're separate
//      control APIs — so the safe pattern never trips it. Neither does
//      `{...values}` or `Object.keys(values)`: spread and enumeration only
//      visit keys the target actually HAS, and a stripped key isn't one of
//      them, so `get` never fires for it — this is what keeps
//      `SkillEditModal`'s `body = { ...values }` (which relies on
//      `builtinSkillFileSchema` stripping `window`/`requiresKey` for a
//      built-in edit as a FEATURE, not a bug) silent, with no special-casing
//      needed. Only a literal `values.key` / `values['key']` / destructuring
//      trips the trap, because property access goes through `get` even when
//      the property doesn't exist — which is exactly the shape of the bug
//      and nothing else reachable in this codebase today reproduces it (see
//      task-14-report.md for the full audit of all `useZodForm` call sites;
//      `RecipeFormValues` in `PlaylistBuilderPanel` is the other close call —
//      18 "phantom" keys by the step-1 diff alone, silent because that form
//      never calls `handleSubmit` at all, so the wrapper is never invoked).
//
// `console.error` rather than throw: the trap fires from inside whatever
// arbitrary `onValid` code the operator wrote, possibly after other side
// effects already started, and a throw there would surface as a confusing
// stack trace inside a Proxy trap instead of at the line that's actually
// wrong — no safer than the bug it's guarding against. A `console.error`
// naming the field and both fixes is loud enough not to miss in a dev
// session, and it can't make anything worse than the silent `undefined`
// already would have.

function resolveTopLevelObjectSchema(schema: z.ZodType, depth = 0): z.ZodObject | null {
  if (depth > 12) return null; // defensive only — nothing here nests this deep
  if (schema instanceof z.ZodObject) return schema;
  // Structural rather than per-wrapper-class: zod4's own def shape carries
  // `innerType` under this exact name on every optional/nullable/default/
  // readonly/nonoptional/prefault wrapper.
  const def = schema.def as unknown as { type: string; innerType?: z.ZodType; out?: z.ZodType };
  if (def.innerType) return resolveTopLevelObjectSchema(def.innerType, depth + 1);
  // A ZodPipe's `.out` is the schema that actually produces the pipe's OUTPUT
  // type — right for `z.preprocess(fn, target)` (out = target). A
  // `.transform()` pipe's `.out` is a bare transform node with no declared
  // shape, so this correctly stops there rather than falling back to `.in`
  // (the PRE-transform shape — provably the wrong answer for what
  // `handleSubmit` actually receives).
  if (def.type === 'pipe' && def.out) return resolveTopLevelObjectSchema(def.out, depth + 1);
  return null;
}

function declaredTopLevelKeys(schema: z.ZodType): Set<string> | null {
  const obj = resolveTopLevelObjectSchema(schema);
  if (!obj) return null;
  const catchall = (obj.def as unknown as { catchall?: z.ZodType }).catchall;
  // .passthrough()/.catchall(x) let unrecognised keys survive — nothing is
  // actually dropped, so there's nothing this probe can prove.
  if (catchall && (catchall.def as unknown as { type?: string }).type !== 'never') return null;
  return new Set(Object.keys(obj.shape));
}

function warnDroppedField(key: string): void {
  console.error(
    `useZodForm: "${key}" is in this form's defaultValues but the bound schema doesn't `
    + `declare it as a key, so z.object() strips it — handleSubmit's callback never receives `
    + `"${key}"; reading values.${key} there is always undefined. This is the bug class `
    + `PlaylistBuilderPanel's saveMode shipped with (see the PITFALL comment atop this file). `
    + `Fix it one of two ways: (1) add "${key}" to the schema's declared shape, or (2) if it's `
    + `deliberately not part of the wire schema, read it via form.getValues('${key}') or `
    + `useWatch({ control, name: '${key}' }) instead of destructuring it off handleSubmit's `
    + 'parsed values.',
  );
}

// Wraps `values` in a Proxy that fires `warnDroppedField` the first time
// application code reads one of `phantomKeys` BY NAME. Enumeration (spread,
// Object.keys, JSON.stringify) never triggers it — see the design note above.
//
// One caveat, not a false positive but worth knowing: `structuredClone(values)`
// throws `DataCloneError` on this Proxy (a plain object clones fine — the
// structured clone algorithm doesn't support arbitrary exotic objects, and a
// Proxy is one). Nothing in `web/` calls `structuredClone` on a submit
// handler's parsed values today, and react-hook-form's own internals clone
// via `cloneObject` (a plain recursive copy), not `structuredClone`, so this
// is latent rather than live — but it would equally bite `postMessage`ing
// `values` to a worker/window or storing them in IndexedDB, so don't reach
// for either on the object handleSubmit hands you without unwrapping it
// (`{ ...values }` first is enough — a spread already returns a plain object).
function wrapWithPhantomFieldWarnings(
  values: unknown,
  phantomKeys: readonly string[],
  warned: Set<string>,
): unknown {
  if (!values || typeof values !== 'object') return values;
  return new Proxy(values as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !warned.has(prop) && phantomKeys.includes(prop)) {
        warned.add(prop);
        warnDroppedField(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// A structural stand-in for react-hook-form's UseFormHandleSubmit —
// deliberately erased to `unknown` on both sides of the callback rather than
// fought generic-for-generic, the same one-cast-not-fought-at-every-callsite
// move the resolver cast in `useZodForm` makes above. Nothing about runtime
// behaviour changes: the wrapped function still calls straight through to
// react-hook-form's own `handleSubmit`, with the caller's `onInvalid`
// untouched — only `onValid`'s `values` argument gets wrapped.
type AnyHandleSubmit = (
  onValid?: (values: unknown, event?: unknown) => unknown,
  onInvalid?: (errors: unknown, event?: unknown) => unknown,
) => (event?: unknown) => Promise<unknown>;

const PHANTOM_PROBE_STATE = Symbol('useZodForm.phantomProbeState');

// Fix round 1 (code review): the marker used to be a plain boolean, set only
// once phantoms were FOUND, and never revisited. That's wrong whenever a
// bound schema changes IDENTITY after mount without the component
// remounting — SkillEditModal.tsx is exactly this shape: `custom` starts as
// the list row's guess and is corrected by the file GET (`setCustom(!!j.custom)`),
// which swaps the bound schema between `builtinSkillFileSchema` (no
// `window`/`requiresKey`) and `customSkillFileSchema` (declares both). Two
// failure directions from a boolean-and-never-again marker: (1) a schema that
// starts WITH phantoms arms a wrapper closing over that phantom set, then
// swaps to a schema that legitimately declares those same keys — the boolean
// short-circuits before ever re-deriving anything, so the stale wrapper keeps
// firing on what is now a CORRECT `values.thatField` read; (2) the opposite
// swap (starts phantom-free, the early return before the marker is ever set
// happens to self-heal) is what made this look fine in earlier manual
// testing, but only by accident of which direction was tried. The fix: key
// the marker on the SCHEMA REFERENCE actually walked last, not a boolean, and
// redo the derivation whenever it differs. Every schema in this codebase that
// changes shape after mount is either a module-level constant (referentially
// stable while its own shape doesn't change) or built fresh each render by a
// factory call whose result identity tracks the inputs that matter
// (`showsFormSchema(showCtx)`/`festivalsSchema({moodNames})` behind
// `useMemo`, `skillFileSchema(custom)` returning one of two module
// constants) — so `!==` is the right comparison, no deep-equality needed.
type PhantomProbeState = { schema: z.ZodType; original: AnyHandleSubmit };

// `form` is typed down to just the one property this touches — the real
// argument is always the full `UseFormReturn` `useZodForm` just built, whose
// object identity is stable for the component's lifetime (react-hook-form
// caches it in a ref and returns the same object every render), so state
// stashed on it here persists across re-renders without needing a `useRef`
// of our own.
function installPhantomFieldProbe(
  form: { handleSubmit: unknown },
  schema: z.ZodType,
  defaultValues: unknown,
): void {
  const marker = form as unknown as Record<symbol, PhantomProbeState | undefined>;
  const state = marker[PHANTOM_PROBE_STATE];

  // Same schema reference as last time this form rendered — already derived
  // (or already proven undecidable) for it, nothing to redo. This is also
  // what keeps a phantom-free form (21 of the 23 call sites) from re-walking
  // its schema on every render past the first: the walk still runs once, but
  // `state.schema === schema` short-circuits every render after.
  if (state && state.schema === schema) return;

  // The PRISTINE react-hook-form `handleSubmit`, captured once and reused as
  // the rebuild base every time the schema changes — never the possibly
  // already-wrapped `form.handleSubmit`, or a second schema swap would wrap
  // an existing wrapper instead of replacing it, stacking Proxies and
  // re-firing warnings for keys the current schema doesn't even drop.
  const original = state ? state.original : (form.handleSubmit as unknown as AnyHandleSubmit);
  marker[PHANTOM_PROBE_STATE] = { schema, original };

  const declared = declaredTopLevelKeys(schema);
  const phantomKeys = declared
    ? Object.keys((defaultValues as Record<string, unknown> | undefined) ?? {})
      .filter((key) => !declared.has(key))
    : []; // can't prove anything is dropped — stay silent

  if (phantomKeys.length === 0) {
    // Nothing (or nothing provable) is dropped by the CURRENT schema. Restore
    // the pristine handleSubmit unconditionally — not a no-op skip — so a
    // schema swap that makes a previously-armed wrapper stale actually
    // un-arms it, rather than leaving yesterday's phantom set live.
    form.handleSubmit = original as unknown as typeof form.handleSubmit;
    return;
  }

  const warned = new Set<string>();
  const wrapped: AnyHandleSubmit = (onValid, onInvalid) =>
    original(
      onValid
        ? (values: unknown, event?: unknown) =>
          onValid(wrapWithPhantomFieldWarnings(values, phantomKeys, warned), event)
        : onValid,
      onInvalid,
    );
  form.handleSubmit = wrapped as unknown as typeof form.handleSubmit;
}

// ARIA wiring for one field, derived from a single base id.
//
// The Field primitives in components/ui/field.tsx are presentational: their
// `data-invalid` turns the LABEL red (fieldVariants in ui/field.tsx is
// `data-[invalid=true]:text-destructive` — the control's own border is not
// styled by it, identically for Input and Textarea), and FieldError renders
// role="alert" so a message is ANNOUNCED the moment it appears. Neither of
// those associates the message with the control, which is what a
// screen-reader user needs when they tab BACK to the input — without it the
// field is an unlabelled-as-invalid box whose explanation was read once and
// is now unreachable.
//
// Returned as spreadable groups so no form open-codes the id suffixes. Two
// forms deriving `-error` differently is exactly the drift this shared
// foundation exists to prevent, and every convertible form has this same shape.
export function fieldAria(
  baseId: string,
  error?: { message?: string },
  opts?: { hasDescription?: boolean },
) {
  const errorId = `${baseId}-error`;
  const descriptionId = `${baseId}-description`;
  const invalid = !!error;
  // Reference only ids that are actually in the DOM: FieldError renders null
  // when there is no error, and a dangling aria-describedby is inconsistently
  // handled across screen readers (dropped by some, announced empty by others).
  const describedBy =
    [opts?.hasDescription ? descriptionId : null, invalid ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return {
    invalid,
    // For a Field wrapping a real control: label points at it, control owns the id.
    labelProps: { htmlFor: baseId },
    controlProps: {
      id: baseId,
      // Absent rather than aria-invalid="false" — the attribute only carries
      // meaning when set, and a literal "false" is noise on every valid field.
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy,
    },
    // For a Field wrapping a GROUP of controls (chips, checkboxes) with no
    // single labelable element: htmlFor would point at a <div>, which is
    // invalid, so the group names itself via aria-labelledby instead.
    labelledByProps: { id: `${baseId}-label` },
    groupProps: {
      'aria-labelledby': `${baseId}-label`,
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy,
    },
    descriptionProps: { id: descriptionId },
    errorProps: { id: errorId },
  } as const;
}

// Maps the controller's `fieldErrors` payload back onto individual inputs.
// The controller emits dotted paths ('webhooks.1.url'), which is exactly
// react-hook-form's setError field syntax — so a rule only the server can
// check still lands on the right input rather than in a toast.
//
// Generic over all three of UseFormReturn's parameters so a form built by
// useZodForm (whose transformed type differs from its field type) is accepted
// without the call site restating anything.
export function applyServerFieldErrors<
  TFieldValues extends FieldValues,
  TContext,
  TTransformedValues,
>(
  form: UseFormReturn<TFieldValues, TContext, TTransformedValues>,
  fieldErrors: Record<string, string> | undefined,
): boolean {
  if (!fieldErrors) return false;
  const entries = Object.entries(fieldErrors);
  for (const [path, message] of entries) {
    form.setError(path as Path<TFieldValues>, { type: 'server', message });
  }
  return entries.length > 0;
}
