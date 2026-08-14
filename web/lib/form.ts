// react-hook-form + zod wiring for the admin entity editors: `useZodForm` and
// `fieldAria` here, the five bound field components in the sibling
// lib/form-fields.tsx. The nine `settings/` sections deliberately don't bind
// through this — see CLAUDE.md's "Shared form schemas (zod)" bullet.
//
// Schemas come from lib/schemas.generated.ts, the CI-drift-checked mirror of
// controller/src/schemas/**, so this resolver enforces the controller's rules.
//
// PITFALL — a registered field that ISN'T a key of the bound schema is
// SILENTLY DROPPED, not a type error: `handleSubmit`'s callback receives the
// resolver's PARSED OUTPUT, and z.object() strips undeclared keys, while
// `register`/`useController` accept any string as `name`. This shipped once
// (PlaylistBuilderPanel's `saveMode`): every "Overwrite existing" save read
// `values.saveMode` as undefined and created a duplicate playlist. Two safe
// patterns: (1) every registered field is a real key of the bound schema, or
// (2) a UI-only field (a local choice, a `File` zod can't describe) is read via
// `form.getValues(name)` / `useWatch({control, name})`, both of which bypass
// the resolver. The dev-only probe below catches violations of (1).
import { zodResolver } from '@hookform/resolvers/zod';
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from 'react-hook-form';
// Value import, not type-only: the phantom-field probe below does a runtime
// `instanceof z.ZodObject` check.
import { z } from 'zod';

// All THREE generics are passed on purpose. handleSubmit's callback receives
// TTransformedValues, which is what zodResolver hands it at runtime
// (z.output<S>). Passing only z.input<S> lets it default to the INPUT type —
// harmless until the first type-CHANGING transform (z.coerce.number(), an
// object-reshaping .transform()), which would then type `values.x` as string
// while it is really a number, with no error anywhere.
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues: DefaultValues<z.input<S>>,
): UseFormReturn<z.input<S>, unknown, z.output<S>> {
  const form = useForm<z.input<S>, unknown, z.output<S>>({
    // Inside this function TS only knows S by its constraint, so it collapses
    // z.input<S>/z.output<S> to FieldValues. The assertion is deliberately on
    // the SCHEMA rather than the resolver, so the Resolver type stays derived
    // from @hookform/resolvers' own signature.
    resolver: zodResolver(schema as unknown as z.ZodType<z.output<S>, z.input<S>>),
    defaultValues,
    // Validate as the operator types, so a Save button's disabled state tracks
    // validity without a submit attempt.
    mode: 'onChange',
  });

  // A plain call, not a hook, so rules-of-hooks is satisfied; NODE_ENV is a
  // build-time constant Next inlines, so prod strips this as dead code.
  if (process.env.NODE_ENV !== 'production') {
    installPhantomFieldProbe(form, schema, defaultValues);
  }

  return form;
}

// ---------------------------------------------------------------------------
// Dev-only phantom-field probe (see the PITFALL comment above).
//
// A lint rule can't do this: several bound schemas have no statically visible
// object shape (`festivalsSchema` strips inside a hand-written transform,
// `showSchema(ctx)` is a runtime factory, `playlistSaveSchema` hides behind a
// `z.preprocess`). Nor can a parse-and-diff of `defaultValues`: a fresh row is
// seeded blank, so the parse fails before there's an output to diff — which is
// exactly the form (PlaylistBuilderPanel, `name: ''`) this needs to catch.
//
// So it works in two parts:
//
//   1. STRUCTURAL, at mount (`declaredTopLevelKeys`): unwrap the schema down to
//      the outermost ZodObject governing top-level keys and diff its `.shape`
//      against `defaultValues`. `z.object()` strips undeclared keys
//      unconditionally, so no successful parse is needed. Gives up rather than
//      guesses when no object is reachable or nothing is actually dropped
//      (`.passthrough()`/`.catchall()`).
//   2. ACCESS-TRACKING, at submit (`wrapWithPhantomFieldWarnings`): a dropped
//      key isn't a bug by itself — PITFALL pattern (2) produces the identical
//      mismatch legitimately, and the two differ only in the `handleSubmit`
//      callback's body, which this file never sees. So step 1 merely arms a
//      Proxy around `values` that warns on the first read BY NAME. `getValues`/
//      `useWatch` never touch that object, and spread/`Object.keys` only visit
//      keys the target actually has — so only a literal `values.key` (the bug's
//      exact shape) trips it.
//
// `console.error` rather than throw: the trap fires from inside arbitrary
// `onValid` code, possibly after side effects, where a throw would surface as a
// stack trace inside a Proxy trap rather than at the wrong line.

function resolveTopLevelObjectSchema(schema: z.ZodType, depth = 0): z.ZodObject | null {
  if (depth > 12) return null; // defensive only — nothing here nests this deep
  if (schema instanceof z.ZodObject) return schema;
  // Structural rather than per-wrapper-class: zod4 carries `innerType` under
  // this exact name on every optional/nullable/default/readonly wrapper.
  const def = schema.def as unknown as { type: string; innerType?: z.ZodType; out?: z.ZodType };
  if (def.innerType) return resolveTopLevelObjectSchema(def.innerType, depth + 1);
  // `.out` is what produces the pipe's OUTPUT type (for `z.preprocess(fn, obj)`
  // that's the object). Never fall back to `.in` — the pre-transform shape is
  // not what `handleSubmit` receives.
  if (def.type === 'pipe' && def.out) return resolveTopLevelObjectSchema(def.out, depth + 1);
  return null;
}

function declaredTopLevelKeys(schema: z.ZodType): Set<string> | null {
  const obj = resolveTopLevelObjectSchema(schema);
  if (!obj) return null;
  // .passthrough()/.catchall(x) let unrecognised keys survive, so nothing is
  // dropped and there is nothing to prove.
  const catchall = (obj.def as unknown as { catchall?: z.ZodType }).catchall;
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
// Caveat: `structuredClone`/`postMessage`/IndexedDB reject a Proxy
// (`DataCloneError`). Nothing does that to submit values today; spread it into
// a plain object first if you ever need to.
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

// A structural stand-in for react-hook-form's UseFormHandleSubmit, erased to
// `unknown` on both sides of the callback rather than fought generic-for-
// generic. The wrapper calls straight through; only `onValid`'s `values`
// argument gets wrapped.
type AnyHandleSubmit = (
  onValid?: (values: unknown, event?: unknown) => unknown,
  onInvalid?: (errors: unknown, event?: unknown) => unknown,
) => (event?: unknown) => Promise<unknown>;

const PHANTOM_PROBE_STATE = Symbol('useZodForm.phantomProbeState');

// Keyed on the schema REFERENCE last walked, not a boolean: a bound schema can
// change identity after mount without a remount (SkillEditModal swaps between
// `builtinSkillFileSchema` and `customSkillFileSchema` once the file GET
// resolves `custom`), and a set-once marker would leave a stale wrapper warning
// on keys the new schema legitimately declares. Every schema here is either a
// module constant or a memoised factory result, so `!==` suffices.
type PhantomProbeState = { schema: z.ZodType; original: AnyHandleSubmit };

// `form` is narrowed to the one property this touches; the real argument is the
// full `UseFormReturn`, whose identity react-hook-form keeps stable for the
// component's lifetime, so state stashed on it survives re-renders.
function installPhantomFieldProbe(
  form: { handleSubmit: unknown },
  schema: z.ZodType,
  defaultValues: unknown,
): void {
  const marker = form as unknown as Record<symbol, PhantomProbeState | undefined>;
  const state = marker[PHANTOM_PROBE_STATE];

  // Already derived (or proven undecidable) for this schema — and this is what
  // keeps the walk to once per form rather than once per render.
  if (state && state.schema === schema) return;

  // The PRISTINE handleSubmit, reused as the rebuild base on every schema
  // change — wrapping the possibly-already-wrapped `form.handleSubmit` would
  // stack Proxies and re-fire warnings for keys the new schema doesn't drop.
  const original = state ? state.original : (form.handleSubmit as unknown as AnyHandleSubmit);
  marker[PHANTOM_PROBE_STATE] = { schema, original };

  const declared = declaredTopLevelKeys(schema);
  const phantomKeys = declared
    ? Object.keys((defaultValues as Record<string, unknown> | undefined) ?? {})
      .filter((key) => !declared.has(key))
    : []; // can't prove anything is dropped — stay silent

  if (phantomKeys.length === 0) {
    // Restore unconditionally rather than skipping, so a schema swap that makes
    // a previously-armed wrapper stale actually un-arms it.
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
// The Field primitives in components/ui/field.tsx are presentational:
// `data-invalid` only reddens the label, and FieldError's role="alert"
// announces a message once when it appears. Neither associates the message with
// the control, so a user tabbing BACK to a bad input gets nothing. Returned as
// spreadable groups so no form open-codes the id suffixes.
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

// Maps the controller's `fieldErrors` payload back onto individual inputs. The
// controller emits dotted paths ('webhooks.1.url'), which is exactly
// react-hook-form's setError syntax, so a server-only rule lands on the right
// input rather than in a toast. Generic over all three of UseFormReturn's
// parameters so a useZodForm-built form needs no restating at the call site.
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
