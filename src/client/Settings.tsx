import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { branchBackendBlocksSubagents } from '../backends.ts'
import type { CatalogModel, CatalogReport } from '../shared.ts'
import { CATALOG_ROUTE } from '../shared.ts'
import type { ModelPrices, ModelRule } from '../config.ts'
import { NS, type Key } from './locales.ts'
import {
  REWRITE_BACKENDS, backendById, backendInstalled, backendReachable, backendOptionsVisible, forcesMasterOff, continuableDepthDisabled, masterSwitchState, nextBackend, normalizeSettings, oneShotDepthDisabled, planSave, ruleFieldsIdle, withoutSubagentKinds,
  type ProbeAnswer,
  type Operation, type SettingsValue, type StoredRule,
} from './ops.ts'
import { InstallBackendPanel } from './InstallBackend.tsx'
import { FALLBACK_RULE, mergeRule, sparseOverride } from '../rule.ts'
import css from './Settings.module.css'

type PriceBucket = { hit: number; miss: number; out: number }
type Snapshot = {
  status: 'loading' | 'ready' | 'unavailable'
  value?: SettingsValue
  revision?: number
  writable: boolean
}
type Form = {
  getSnapshot: () => Snapshot
  subscribe: (listener: () => void) => () => void
  mutate: (ops: readonly Operation[], revision?: number) => Promise<boolean>
}
type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & { form: Form }
type Translate = Props['t']
type Draft = SettingsValue

const FIELDS = ['hit', 'miss', 'out'] as const
const PERIODS = ['peak', 'off'] as const

/**
 * The retired global one-shot switch may still sit on the stored document; the
 * panel must read it so its view matches the engine's derivation.
 * @param value - the raw stored document.
 * @returns that legacy flag when present.
 */
function legacyOneShotOf(value: SettingsValue | undefined): boolean | undefined {
  const legacy = (value as { compressSubagents?: unknown } | undefined)?.compressSubagents
  return typeof legacy === 'boolean' ? legacy : undefined
}

/**
 * Normalize the stored document exactly the way the engine resolves it.
 * @param value - the raw stored document.
 * @returns the draft the panel edits.
 */
function normalize(value: SettingsValue): Draft {
  return normalizeSettings(value, legacyOneShotOf(value)) as Draft
}

function numberValue(raw: string): number {
  return raw === '' ? 0 : Number(raw)
}

/**
 * Single-select list of the installed companions that can write a rewrite into
 * the session's history.
 *
 * Availability is probed once per mount: a backend whose endpoint answers
 * anything other than 404 is installed and may be chosen. Choosing the selected
 * row again clears the choice; with no choice the master switch is locked off.
 * @param props - current id, selection callback, and translator.
 * @returns the chooser.
 */
function BackendChooser({ value, onSelect, t }: {
  value: string
  onSelect: (id: string) => void
  t: Translate
}) {
  const [available, setAvailable] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let alive = true
    /** One probe: status, content type and a short body — everything worth comparing. */
    const probe = async (path: string, body: Record<string, unknown>): Promise<ProbeAnswer> => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: (await response.text()).slice(0, 200),
      }
    }
    for (const backend of REWRITE_BACKENDS) {
      // A placeholder has no route, so there is nothing to ask and no answer that could make it
      // selectable: it stays out of the probe and out of the availability map.
      const route = backend.probe
      if (route === undefined) continue
      // A sibling path in the same namespace cannot exist: its answer is what the web
      // server says for "no such route here", which is the yardstick this backend's own
      // answer has to differ from. Both are probed with the same body and method.
      void probe(route.path, route.body)
        .then(async answer => {
          const absent = await probe(`${route.path}-absent`, route.body)
          if (alive) setAvailable(current => ({ ...current, [backend.id]: backendInstalled(answer, absent) }))
        })
        .catch(() => {
          if (alive) setAvailable(current => ({ ...current, [backend.id]: false }))
        })
    }
    return () => { alive = false }
  }, [])
  return <div className={css.checks}>
    {REWRITE_BACKENDS.map(backend => {
      const installed = available[backend.id] === true
      const selected = value === backend.id
      return <label key={backend.id} className={css.inline}>
        <input
          type="checkbox"
          checked={selected}
          disabled={!installed}
          onChange={() => onSelect(nextBackend(value, backend.id))}
        />
        {backend.placeholder === true
          ? <span>{backend.id} · {t('settings.backendPlaceholder')}</span>
          : <>
            <span>{backend.id} · {backend.kind === 'branch' ? t('settings.backendBranch') : t('settings.backendInPlace')}</span>
            <span className={css.muted}>{installed ? t('settings.backendInstalled') : t('settings.backendMissing')}</span>
          </>}
      </label>
    })}
    <span className={css.note}>{t('settings.backendHint')}</span>
  </div>
}

function Toggle({ label, checked, onChange, disabled = false }: {
  label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean
}) {
  return <label className={css.toggle}><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>
}

function Count({ label, value, onChange, disabled = false }: {
  label: string; value: number; onChange: (value: number) => void; disabled?: boolean
}) {
  return <label className={css.field}><span>{label}</span><input type="number" min="0" step="1" value={value} disabled={disabled} onChange={event => onChange(numberValue(event.target.value))} /></label>
}

function RouteFields({ rule, catalog, onChange, t, disabled = false }: {
  rule: ModelRule; catalog: CatalogReport | null; onChange: (value: ModelRule) => void; t: Translate; disabled?: boolean
}) {
  const route = rule.distiller
  const routes = catalog?.models ?? []
  const providers = [...new Set([...routes.map(model => model.provider), route.provider])]
  const models = routes.filter(model => model.provider === route.provider)
  const selected = models.find(model => model.id === route.model)
  const efforts = [...new Set(['off', ...(selected?.reasoningEfforts ?? []), route.effort])]
  const change = (next: Partial<typeof route>) => onChange({ ...rule, distiller: { ...route, ...next } })
  return <div className={css.route}>
    <label className={css.field}><span>{t('settings.provider')}</span><select disabled={disabled} value={route.provider} onChange={event => {
      const provider = event.target.value
      const first = routes.find(model => model.provider === provider)
      change({ provider, model: first?.id ?? route.model, effort: first?.defaultEffort ?? 'off' })
    }}>{providers.map(provider => <option key={provider} value={provider}>{provider}</option>)}</select></label>
    <label className={css.field}><span>{t('settings.model')}</span><select disabled={disabled} value={route.model} onChange={event => {
      const next = models.find(model => model.id === event.target.value)
      change({ model: event.target.value, effort: next?.defaultEffort ?? 'off' })
    }}>{!models.some(model => model.id === route.model) && <option value={route.model}>{route.model}</option>}{models.map(model => <option key={`${model.provider}/${model.id}`} value={model.id}>{model.name} ({model.id})</option>)}</select></label>
    <label className={css.field}><span>{t('settings.effort')}</span><select disabled={disabled} value={route.effort} onChange={event => change({ effort: event.target.value })}>{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
  </div>
}

function RuleFields({ rule, catalog, onChange, t, isModel = false, subagentsLocked = false }: {
  rule: ModelRule; catalog: CatalogReport | null; onChange: (value: ModelRule) => void; t: Translate; isModel?: boolean
  /** Whether the selected backend cannot serve a subagent session at all. */
  subagentsLocked?: boolean
}) {
  const change = (next: Partial<ModelRule>) => onChange({ ...rule, ...next })
  // With all three kinds off this rule decides nothing, so the rest of its
  // settings cannot take effect and are shown locked.
  const idle = ruleFieldsIdle(rule)
  return <div className={css.rule}>
    <div className={css.checks}>
      <Toggle label={t('settings.enabled')} checked={rule.enabled} onChange={enabled => change({ enabled })} />
      <Toggle label={t('settings.continuable')} checked={subagentsLocked ? false : rule.continuableSubagents} disabled={subagentsLocked} onChange={continuableSubagents => change({ continuableSubagents })} />
      <Count label={t('settings.maxDepth')} value={rule.continuableMaxDepth} disabled={subagentsLocked || continuableDepthDisabled(rule)} onChange={continuableMaxDepth => change({ continuableMaxDepth })} />
      <Toggle label={t('settings.oneShot')} checked={subagentsLocked ? false : rule.oneShotSubagents} disabled={subagentsLocked} onChange={oneShotSubagents => change({ oneShotSubagents })} />
      <Count label={t('settings.maxDepth')} value={rule.oneShotMaxDepth} disabled={subagentsLocked || oneShotDepthDisabled(rule)} onChange={oneShotMaxDepth => change({ oneShotMaxDepth })} />
      {subagentsLocked && <span className={css.note} role="status">{t('settings.subagentsLocked')}</span>}
      <span className={css.note}>{t('settings.kindsHint')}</span>
      <span className={css.note}>{t('settings.maxDepthHint')}</span>
    </div>
    <div className={css.checks}>
      <Toggle label={t('settings.tools')} checked={rule.includeToolResults} disabled={idle} onChange={includeToolResults => change({ includeToolResults })} />
      <span className={css.note}>{t('settings.toolsHint')}</span>
      <Toggle label={t('settings.final')} checked={rule.includeFinalTurns} disabled={idle} onChange={includeFinalTurns => change({ includeFinalTurns })} />
    </div>
    <p className={css.note}>{t('settings.ruleIdle')}</p>
    <div className={css.route}>
      <Count label={t('settings.threshold')} value={rule.thresholdTokens} disabled={idle} onChange={thresholdTokens => change({ thresholdTokens })} />
      <Count label={t('settings.minimum')} value={rule.minSavedTokens} disabled={idle} onChange={minSavedTokens => change({ minSavedTokens })} />
      <Count label={t('settings.timeout')} value={rule.timeoutMs} disabled={idle} onChange={timeoutMs => change({ timeoutMs })} />
      <Count label={t('settings.maxInput')} value={rule.maxInputChars} disabled={idle} onChange={maxInputChars => change({ maxInputChars })} />
      <Count label={t('settings.maxOutput')} value={rule.maxOutputChars} disabled={idle} onChange={maxOutputChars => change({ maxOutputChars })} />
    </div>
    <p className={css.note}>{t('settings.timeoutHint')}</p>
    <RouteFields rule={rule} catalog={catalog} onChange={onChange} t={t} disabled={idle} />
  </div>
}

type PriceDraft = { peak: PriceBucket; off: PriceBucket; peakPricing: boolean }

function PriceEditor({ model, prices, builtin, onChange, onRemove, t }: {
  model: CatalogModel; prices: Partial<ModelPrices> | undefined; builtin: PriceBucket | undefined;
  onChange: (value: PriceDraft) => void; onRemove: () => void; t: Translate
}) {
  const base = builtin ?? { hit: 0, miss: 0, out: 0 }
  const peak = { ...base, ...prices?.peak }
  const off = { hit: peak.hit / 2, miss: peak.miss / 2, out: peak.out / 2, ...prices?.off }
  const current: PriceDraft = { peak, off, peakPricing: prices?.peakPricing === true }
  return <details className={css.item}><summary><strong>{model.name}</strong><span className={css.muted}>{model.id}</span>{prices && <span className={css.badge}>●</span>}</summary>
    <div className={css.itemBody}>
      <Toggle label={t('settings.peakPricing')} checked={current.peakPricing} onChange={peakPricing => onChange({ ...current, peakPricing })} />
      <p className={css.note}>{t('settings.peakPricingHint')}</p>
      <p className={css.note}>{t('settings.priceUnit')}</p>
      {!builtin && <p className={css.note}>{t('settings.noBuiltin')}</p>}
      {builtin && <button type="button" className={css.secondary} onClick={() => onChange({ ...current, peak: builtin, off: { hit: builtin.hit / 2, miss: builtin.miss / 2, out: builtin.out / 2 }, peakPricing: true })}>{t('settings.fillPrices')}</button>}
      <div className={css.priceGrid}>
        {PERIODS.map(period => <fieldset key={period} disabled={period === 'off' && !current.peakPricing}><legend>{t(!current.peakPricing && period === 'peak' ? 'settings.priceOnce' : `settings.${period}` as Key)}</legend><div className={css.route}>{FIELDS.map(field => <label className={css.field} key={field}><span>{t(`settings.${field}` as Key)}</span><input type="number" min="0" step="any" placeholder={String(period === 'peak' ? base[field] : base[field] / 2)} value={prices?.[period]?.[field] ?? ''} onChange={event => onChange({ ...current, [period]: { ...current[period], [field]: numberValue(event.target.value) } })} /></label>)}</div></fieldset>)}
      </div>
      <div className={css.actions}><button type="button" className={css.secondary} onClick={onRemove}>{t('settings.remove')}</button></div>
    </div>
  </details>
}

/**
 * On-demand model chooser: the section lists only what the user added, and this
 * is the single way to bring another route in.
 */
function ModelPicker({ catalog, taken, label, onPick, t }: {
  catalog: CatalogReport | null; taken: readonly string[]; label: string
  onPick: (model: CatalogModel) => void; t: Translate
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const seen = new Set(taken)
  const available = (catalog?.models ?? []).filter(model => !seen.has(model.id))
  const needle = query.trim().toLowerCase()
  const shown = needle === ''
    ? available
    : available.filter(model => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle))
  return <div className={css.picker}>
    <button type="button" className={css.secondary} onClick={() => { setOpen(value => !value); setQuery('') }}>{open ? t('settings.cancel') : label}</button>
    {open && <div className={css.pickerPanel}>
      <input className={css.search} value={query} placeholder={t('settings.search')} autoFocus onChange={event => setQuery(event.target.value)} />
      <div className={css.pickerList}>
        {shown.length === 0 && <p className={css.note}>{available.length === 0 ? t('settings.allAdded') : t('settings.noMatch')}</p>}
        {shown.map(model => <button type="button" key={`${model.provider}/${model.id}`} className={css.pickerItem} onClick={() => { onPick(model); setOpen(false); setQuery('') }}>
          <strong>{model.name}</strong><span className={css.muted}>{model.provider}/{model.id}</span>
        </button>)}
      </div>
    </div>}
  </div>
}

// Re-exported so tests can pin the panel's defaults against the host's rule.
export { FALLBACK_RULE }

export function ReasoningDistillSettings({ form, t }: Props) {
  const snapshot = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getSnapshot)
  const [draft, setDraft] = useState<Draft | null>(null)
  /** The host value the draft was derived from; saves diff against this. */
  const [baseline, setBaseline] = useState<SettingsValue | null>(null)
  const [dirty, setDirty] = useState(false)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'failure'>('idle')
  const [catalog, setCatalog] = useState<CatalogReport | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [installOpen, setInstallOpen] = useState(false)
  const editRevision = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    setCatalogError(false)
    fetch(CATALOG_ROUTE, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(String(response.status))
      setCatalog(await response.json() as CatalogReport)
    }).catch(() => { if (!controller.signal.aborted) setCatalogError(true) })
    return () => controller.abort()
  }, [catalogAttempt])
  useEffect(() => {
    if (snapshot.status !== 'ready' || !snapshot.value || dirty || state === 'saving') return
    // Follow the host whenever this panel has no unsaved edits, so a change made
    // by another client (or by an earlier save) is adopted instead of being
    // written back from a stale draft.
    const value = snapshot.value
    setDraft(normalize(value))
    // The baseline must be the same derivation the draft came from, or saving an
    // unrelated field would write the derived switches back as explicit values.
    setBaseline(normalize(value))
  }, [snapshot, dirty, state])

  const update = (change: (current: Draft) => Draft) => {
    editRevision.current++
    setDraft(current => current && change(current))
    setDirty(true)
    setState('idle')
  }
  const save = async () => {
    if (!draft || !snapshot.writable || snapshot.revision === undefined || state === 'saving') return
    const savedDraft = structuredClone(draft)
    const startedAt = editRevision.current
    if (!snapshot.value) return
    // Diff against the value this draft came from, never against the latest one:
    // anything this user did not edit stays untouched, including fields another
    // client changed while this draft was open.
    const ops = planSave(baseline, snapshot.value, savedDraft)
    if (ops.length === 0) { if (editRevision.current === startedAt) { setDirty(false); setState('saved') }; return }
    setState('saving')
    try {
      const accepted = await form.mutate(ops, snapshot.revision)
      if (!accepted) { setState('conflict'); return }
      // An edit made during the write remains unsaved and must not be discarded.
      if (editRevision.current === startedAt) {
        setDirty(false)
        setState('saved')
      } else setState('idle')
    } catch { setState('failure') }
  }

  // Probed availability of the *selected* backend: a backend whose plugin was removed stays
  // selected in storage, and the switch must follow the probe rather than the stored id. Declared
  // above the loading return -- hooks may never follow an early return, or the panel would crash
  // on the transition from loading to ready and render nothing at all.
  const selectedBackendId = draft?.rewriteBackend
  const [selectedReachable, setSelectedReachable] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    const selected = selectedBackendId === undefined ? undefined : backendById(selectedBackendId)
    if (selected === undefined) {
      setSelectedReachable(undefined)
      return
    }
    let alive = true
    void backendReachable(selected).then(reachable => { if (alive) setSelectedReachable(reachable) })
    return () => { alive = false }
  }, [selectedBackendId])
  // A switch locked because its backend cannot apply anything must not stay on in storage: the
  // panel would show off while the engine kept attempting a hand-off that fails.
  useEffect(() => {
    if (draft == null) return
    if (!forcesMasterOff(draft.rewriteBackend, draft.enabled, selectedReachable)) return
    setDraft(current => current == null ? current : { ...current, enabled: false })
  }, [draft, selectedReachable])
  // The same rule for the two subagent switches: a switch this backend cannot honour must not
  // stay on in storage, or the panel would show off while the engine kept attempting the hand-off.
  // `withoutSubagentKinds` returns its input unchanged once every layer is pinned, so this settles.
  useEffect(() => {
    if (draft == null || !branchBackendBlocksSubagents(draft.rewriteBackend)) return
    setDraft(current => current == null ? current : withoutSubagentKinds(current))
  }, [draft])

  if (snapshot.status === 'loading' || !draft) return <div className={css.page}>{t('settings.loading')}</div>
  const writable = snapshot.status === 'ready' && snapshot.writable
  // Only what the user added is listed; a configured id that the catalog no
  // longer offers still renders so it can be edited or removed.
  const ruleIds = Object.keys(draft.models)
  const priceIds = Object.keys(draft.prices)
  const resolveModel = (id: string): CatalogModel =>
    (catalog?.models ?? []).find(model => model.id === id) ?? { provider: '', id, name: id, reasoningEfforts: [] }
  const master = masterSwitchState(draft.rewriteBackend, draft.enabled, selectedReachable)
  // A branch backend hands a rewrite over by forking the conversation, and the host writes a
  // delegation's parent relation when the child agent is created, so a hand-off inside a subagent
  // would end that child's turn without an answer. Both subagent switches are therefore pinned
  // off — shown locked, and written off so storage cannot disagree with the panel.
  const subagentsLocked = branchBackendBlocksSubagents(draft.rewriteBackend)
  const ruleModels = ruleIds.map(resolveModel)
  const priceModels = priceIds.map(resolveModel)
  // Exactly what the engine will resolve, so the panel cannot show a rule the
  // runtime would not apply.
  const ruleOf = (model: CatalogModel): ModelRule =>
    mergeRule(FALLBACK_RULE, draft.defaultRule, draft.models[model.id])
  return <div className={css.page}>
    <header className={css.header}><h2>{t('settings.title')}</h2><div className={css.actions}>
      <span role="status" className={state === 'conflict' || state === 'failure' ? css.error : css.note}>{state === 'idle' ? dirty ? t('settings.unsaved') : '' : t(`settings.${state}` as Key)}</span>
      <button type="button" className={css.secondary} disabled={!dirty || state === 'saving'} onClick={() => { if (snapshot.value) setDraft(normalize(snapshot.value)); editRevision.current++; setDirty(false); setState('idle') }}>{t('settings.discard')}</button>
      <button type="button" className={css.primary} disabled={!writable || !dirty || state === 'saving'} onClick={() => { void save() }}>{t('settings.save')}</button>
    </div></header>
    {!writable && <p role="alert" className={css.error}>{t('settings.unavailable')}</p>}
    <section className={css.section}>
      <Toggle label={t('settings.master')} checked={master.checked} disabled={master.locked}
        onChange={enabled => { if (!master.locked) update(current => ({ ...current, enabled })) }} />
      {master.locked && <p className={css.note}>{t('settings.masterLocked')}</p>}
    </section>
    <section className={css.section}>
      <h3>{t('settings.backend')}</h3>
      <BackendChooser value={draft.rewriteBackend} t={t} onSelect={id => update(current => ({
        ...current,
        rewriteBackend: id,
        // Losing the last backend means nothing could apply a rewrite, so the
        // master switch closes with it; picking one leaves the choice to the user.
        ...(id === '' ? { enabled: false } : {}),
      }))} />
      {/* Options that only mean something for the selected backend, shown with it:
          a branch backend is the only one that can leave a superseded conversation
          behind, and the only one the host has to wait on. */}
      {backendOptionsVisible(draft.rewriteBackend) && <div className={css.backendOptions}>
        <h4>{t('settings.branchOptions')} · {draft.rewriteBackend}</h4>
        <Toggle label={t('settings.archiveSuperseded')} checked={draft.archiveSuperseded}
          onChange={archiveSuperseded => update(current => ({ ...current, archiveSuperseded }))} />
        <p className={css.note}>{t('settings.archiveSupersededHint')}</p>
        <Toggle label={t('settings.skipWhileBusy')} checked={draft.skipWhileBusy}
          onChange={skipWhileBusy => update(current => ({ ...current, skipWhileBusy }))} />
        <p className={css.note}>{t('settings.skipWhileBusyHint')}</p>
        <Count label={t('settings.branchTimeout')} value={draft.branchTimeoutMs}
          onChange={branchTimeoutMs => update(current => ({ ...current, branchTimeoutMs }))} />
        <p className={css.note}>{t('settings.branchTimeoutHint')}</p>
      </div>}
      {/* Installing a backend is independent of the choice above, so the entry sits
          beside the chooser rather than inside the branch-only options. */}
      <div className={css.installEntry}>
        <button type="button" className={css.secondary} onClick={() => setInstallOpen(true)}>{t('settings.installOpen')}</button>
        <span className={css.note}>{t('settings.installHint')}</span>
      </div>
    </section>
    <section className={css.section}><h3>{t('settings.default')}</h3><RuleFields rule={draft.defaultRule} catalog={catalog} t={t} subagentsLocked={subagentsLocked} onChange={defaultRule => update(current => ({ ...current, defaultRule }))} /></section>
    <section className={css.section}><div className={css.sectionHeading}><h3>{t('settings.models')}</h3>{catalogError && <button type="button" className={css.iconButton} title={t('settings.retry')} aria-label={t('settings.retry')} onClick={() => setCatalogAttempt(n => n + 1)}><IconRefreshOutlineRegular /></button>}</div>
      {catalogError && <p role="alert" className={css.error}>{t('settings.catalogFailure')}</p>}
      <p className={css.note}>{t('settings.modelsHint')}</p>
      <ModelPicker catalog={catalog} taken={ruleIds} label={t('settings.addModel')} t={t}
        onPick={model => update(current => ({
          ...current,
          // A fresh entry starts with all three kinds off and everything else
          // inherited from the default rule.
          models: { ...current.models, [model.id]: { enabled: false, continuableSubagents: false, oneShotSubagents: false } },
        }))} />
      {ruleIds.length === 0 && <p className={css.note}>{t('settings.noOverrides')}</p>}
      {ruleModels.map(model => <details key={model.id} className={css.item}>
        <summary><strong>{model.name}</strong><span className={css.muted}>{model.provider === '' ? model.id : `${model.provider}/${model.id}`}</span><span className={css.badge}>{t('settings.override')}</span></summary>
        <div className={css.itemBody}>
          <RuleFields isModel rule={ruleOf(model)} catalog={catalog} t={t} subagentsLocked={subagentsLocked} onChange={next => update(current => ({
            ...current,
            // Store only what this model changes, so untouched fields keep
            // following the default rule instead of being frozen.
            models: { ...current.models, [model.id]: sparseOverride(mergeRule(FALLBACK_RULE, current.defaultRule, undefined), next) },
          }))} />
          <div className={css.actions}><button type="button" className={css.secondary} onClick={() => update(current => { const models = { ...current.models }; delete models[model.id]; return { ...current, models } })}>{t('settings.remove')}</button></div>
        </div>
      </details>)}
    </section>
    <section className={css.section}><h3>{t('settings.prices')}</h3>
      <p className={css.note}>{t('settings.peakHint')}</p>
      <p className={css.note}>{t('settings.peakSourceHint')}</p>
      <details className={css.peakBox}><summary>{t('settings.peakWindows')}</summary>
        <label className={css.field}><span>{t('settings.peakSource')}</span>
          <select value={draft.peakSource} onChange={event => update(current => ({ ...current, peakSource: event.target.value }))}>
            <option value="builtin">{t('settings.peakBuiltin')}</option>
            <option value="whale">{t('settings.peakWhale')}</option>
          </select>
        </label>
        <p className={draft.peakSource === 'whale' && (catalog?.peak?.whaleDetected ?? false) === false && catalog !== null ? css.error : css.note}>
          {catalog === null
            ? ''
            : (catalog.peak?.whaleDetected ?? false)
              ? `${t('settings.whaleFound')} · ${catalog.peak?.whaleHolidays ?? 0} ${t('settings.holidaysUnit')}`
              : t('settings.whaleMissing')}
        </p>
        <label className={css.field}><span>{t('settings.holidays')}</span>
          <textarea className={css.holidayBox} value={draft.holidays.join('\n')} onChange={event => update(current => ({ ...current, holidays: event.target.value.split('\n').map(line => line.trim()).filter(line => line !== '') }))} />
        </label>
        <div className={css.actions}><button type="button" className={css.secondary} disabled={catalog === null} onClick={() => update(current => ({ ...current, holidays: [...(catalog?.peak?.builtinHolidays ?? [])] }))}>{t('settings.holidaysReset')}</button></div>
      </details>
      <p className={css.note}>{t('settings.pricesHint')}</p>
      <ModelPicker catalog={catalog} taken={priceIds} label={t('settings.addPrice')} t={t}
        onPick={model => update(current => ({ ...current, prices: { ...current.prices, [model.id]: current.prices[model.id] ?? {} } }))} />
      {priceIds.length === 0 && <p className={css.note}>{t('settings.noPrices')}</p>}
      {priceModels.map(model => <PriceEditor key={model.id} model={model} prices={draft.prices[model.id]} builtin={catalog?.builtinPrices[model.id]} t={t}
        onChange={value => update(current => ({ ...current, prices: { ...current.prices, [model.id]: value } }))}
        onRemove={() => update(current => { const prices = { ...current.prices }; delete prices[model.id]; return { ...current, prices } })} />)}
    </section>
    <section className={css.section}><h3>{t('settings.prompt')}</h3><p className={css.note}>{t('settings.promptHint')}</p><textarea className={css.prompt} value={draft.prompt} onChange={event => update(current => ({ ...current, prompt: event.target.value }))} placeholder={catalog?.defaultPrompt ?? ''} /><div className={css.actions}><button type="button" className={css.secondary} onClick={() => update(current => ({ ...current, prompt: '' }))}>{t('settings.resetPrompt')}</button></div><details className={css.preview}><summary>{t('settings.preview')}</summary><pre>{catalog?.defaultPrompt ?? ''}</pre></details></section>
    <InstallBackendPanel open={installOpen} onClose={() => setInstallOpen(false)} t={t} />
  </div>
}
