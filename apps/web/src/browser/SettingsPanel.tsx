/**
 * Settings: the two namespaces this host actually has, with desired and
 * effective state kept apart.
 *
 * The panel edits exactly the closed forms the host validates — a system prompt
 * and the loop budget for `host`; provider, model and the three bounded model
 * options for `model` — and nothing else. There is no credential field, no
 * arbitrary key, no header bag: a setting this page could send but the host
 * would refuse is not a setting, and inventing one would only make the refusal
 * look like a bug.
 *
 * The draft is a page-local thing and says so. What the host asked for and what
 * the host instance runs are read from the client's own settings cache, never
 * from the draft; a `settings.updated` event that moves the host's revision
 * while a draft is dirty is surfaced as "the host changed", and the user decides
 * whether to reload or keep editing. Saving is a full replacement against the
 * revision the draft was read at, and a save that succeeds says *saved* — never
 * *applied*: applying is a restart's job, and this page has no restart button.
 */

import { useState } from "react";

import type { ClientSnapshot } from "@every-dagent/client";
import type { JsonValue } from "@every-dagent/protocol";

import { settingsAuthorityChanged } from "./presentation.js";
import type { ShellUiState, SettingsSaveOutcome } from "./controller.js";

export interface SettingsPanelProps {
  readonly snapshot: ClientSnapshot;
  readonly ui: ShellUiState;
  readonly canWrite: boolean;
  onRead(namespace: string): void;
  onSave(namespace: string, value: JsonValue, expectedRevision: number): Promise<SettingsSaveOutcome>;
}

/** The host namespace's closed form, as text fields. */
interface HostDraft {
  readonly systemPrompt: string;
  readonly maxSteps: string;
  readonly maxModelAttempts: string;
}

/** The model namespace's closed form, as text fields. */
interface ModelDraft {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly outputReserveTokens: string;
  readonly timeoutMs: string;
}

interface Draft {
  readonly namespace: string;
  /** The revision the draft was read at: what a save compares against. */
  readonly baseRevision: number;
  /**
   * The host instance the draft was read from.
   *
   * A revision is a number inside one host's authority, and two hosts can sit
   * at the same number: the identity is what says the draft belongs to *this*
   * host, and a draft that outlived it must be re-based rather than written to
   * whoever is connected now.
   */
  readonly hostInstanceId: string | null;
  /** Bumped by every edit: a completion may only clear the version it submitted. */
  readonly version: number;
  readonly host: HostDraft;
  readonly model: ModelDraft;
}

const MAX_STEPS_BOUND = { min: 1, max: 12 };
const MAX_MODEL_ATTEMPTS_BOUND = { min: 1, max: 3 };

/** One settings value as a plain record, without trusting its shape. */
function asRecord(value: JsonValue | null | undefined): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null) return {};
  if (Array.isArray(value)) return {};
  const record: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

function hostDraftOf(value: JsonValue | null): HostDraft {
  const record = asRecord(value);
  const loop = asRecord(record["loop"]);
  const text = (input: JsonValue | undefined): string => (typeof input === "string" || typeof input === "number" ? String(input) : "");
  return {
    systemPrompt: text(record["systemPrompt"]),
    maxSteps: text(loop["maxSteps"]),
    maxModelAttempts: text(loop["maxModelAttempts"]),
  };
}

function modelDraftOf(value: JsonValue | null): ModelDraft {
  const record = asRecord(value);
  const text = (input: JsonValue | undefined): string => (typeof input === "string" || typeof input === "number" ? String(input) : "");
  return {
    provider: text(record["provider"]),
    model: text(record["model"]),
    baseURL: text(record["baseURL"]),
    outputReserveTokens: text(record["outputReserveTokens"]),
    timeoutMs: text(record["timeoutMs"]),
  };
}

/** The whole host value the draft asks for, or a reason it cannot be built. */
function hostValueOf(draft: HostDraft): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly reason: string } {
  const maxSteps = Number(draft.maxSteps);
  const maxModelAttempts = Number(draft.maxModelAttempts);
  if (!Number.isInteger(maxSteps) || maxSteps < MAX_STEPS_BOUND.min || maxSteps > MAX_STEPS_BOUND.max) {
    return { ok: false, reason: `maxSteps 需要 ${MAX_STEPS_BOUND.min}–${MAX_STEPS_BOUND.max} 的整数` };
  }
  if (!Number.isInteger(maxModelAttempts) || maxModelAttempts < MAX_MODEL_ATTEMPTS_BOUND.min || maxModelAttempts > MAX_MODEL_ATTEMPTS_BOUND.max) {
    return { ok: false, reason: `maxModelAttempts 需要 ${MAX_MODEL_ATTEMPTS_BOUND.min}–${MAX_MODEL_ATTEMPTS_BOUND.max} 的整数` };
  }
  return { ok: true, value: { systemPrompt: draft.systemPrompt, loop: { maxSteps, maxModelAttempts } } };
}

/** The whole model value the draft asks for, or a reason it cannot be built. */
function modelValueOf(draft: ModelDraft): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly reason: string } {
  if (draft.provider.trim() === "" || draft.model.trim() === "") {
    return { ok: false, reason: "provider 与 model 都不能为空" };
  }
  const value: Record<string, JsonValue> = { provider: draft.provider, model: draft.model };
  if (draft.baseURL.trim() !== "") value["baseURL"] = draft.baseURL;
  for (const [field, name] of [
    [draft.outputReserveTokens, "outputReserveTokens"],
    [draft.timeoutMs, "timeoutMs"],
  ] as const) {
    if (field.trim() === "") continue;
    const parsed = Number(field);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return { ok: false, reason: `${name} 需要正整数` };
    value[name] = parsed;
  }
  return { ok: true, value };
}

function unchanged(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { snapshot, ui } = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entryOf = (namespace: string) => (Object.hasOwn(snapshot.settings, namespace) ? snapshot.settings[namespace] : undefined);

  function openEditor(namespace: string, desiredRevision: number, value: JsonValue | null): void {
    setError(null);
    setDraft({
      namespace,
      baseRevision: desiredRevision,
      hostInstanceId: snapshot.description?.hostInstanceId ?? null,
      version: 0,
      host: hostDraftOf(value),
      model: modelDraftOf(value),
    });
  }

  /** Every edit bumps the draft's version, so a late completion cannot clear it. */
  function edit(next: Draft): void {
    setDraft({ ...next, version: next.version + 1 });
  }

  function currentValueOf(namespace: string, value: JsonValue | null): JsonValue | null {
    if (draft === null || draft.namespace !== namespace) return null;
    const built = namespace === "host" ? hostValueOf(draft.host) : modelValueOf(draft.model);
    void value;
    return built.ok ? built.value : null;
  }

  return (
    <section className="panel" data-testid="settings-panel">
      <header className="panel__head">
        <h2>设置</h2>
      </header>
      {(["host", "model"] as const).map((namespace) => {
        const entry = entryOf(namespace);
        const snapshotValue = entry?.snapshot ?? null;
        const desiredRevision = entry?.desiredRevision ?? null;
        const effectiveRevision = entry?.effectiveRevision ?? null;
        const restartRequired = entry?.restartRequired ?? false;
        const pending = ui.settingsPending !== null && ui.settingsPending.namespace === namespace;
        const editing = draft !== null && draft.namespace === namespace;
        const dirty =
          editing &&
          snapshotValue !== null &&
          currentValueOf(namespace, snapshotValue.desiredValue) !== null &&
          !unchanged(currentValueOf(namespace, snapshotValue.desiredValue) ?? null, snapshotValue.desiredValue);
        // What matters is the revision the *host* has announced, not the one
        // inside the value this client happened to read: an invalidation moves
        // the announced revision without carrying a new value, and a draft
        // built on the older revision is exactly the case that must be shown.
        const hostMoved = editing && desiredRevision !== null && desiredRevision !== draft.baseRevision;
        // The draft's authority is the host instance it was read from: equal
        // revision numbers on two hosts are not the same base.
        const authorityChanged =
          editing && settingsAuthorityChanged(draft.hostInstanceId, snapshot.description?.hostInstanceId ?? null);
        const canSave = !authorityChanged;

        return (
          <div className="settings" key={namespace} data-testid={`settings-${namespace}`}>
            <div className="settings__head">
              <span className="settings__name">{namespace}</span>
              <button
                type="button"
                className="button button--small"
                data-testid={`settings-read-${namespace}`}
                disabled={pending || !props.canWrite}
                onClick={() => {
                  props.onRead(namespace);
                }}
              >
                {pending ? "读取中…" : entry === undefined ? "读取设置" : "重新读取"}
              </button>
            </div>

            {entry === undefined && (
              <p className="panel__note" data-testid={`settings-unread-${namespace}`}>
                尚未读取该命名空间的设置。读取后才能看到 Host 的 desired/effective 状态。
              </p>
            )}

            {(entry !== undefined || editing) && (
              <>
                {entry !== undefined && (
                  <p className="panel__detail" data-testid={`settings-revisions-${namespace}`}>
                  desired 修订 {desiredRevision ?? "未知"} · 本实例生效修订 {effectiveRevision === null ? "未应用" : effectiveRevision}
                    {entry.stale ? " · 已过期：Host 的修订已经前进，这里显示的是上次读取的值，请重新读取" : ""}
                  </p>
                )}
                {entry !== undefined && (
                  <p className="panel__detail" data-testid={`settings-restart-${namespace}`}>
                    {restartRequired
                      ? "需要重启 Host 进程后才会应用（Host 的 restartRequired=true；即使值看起来相同也以 Host 为准）。"
                      : "本实例当前没有待重启的配置。"}
                  </p>
                )}

                {snapshotValue !== null && (
                  <div className="settings__values">
                    <p className="settings__value" data-testid={`settings-desired-${namespace}`}>
                      desired（已保存）：{JSON.stringify(snapshotValue.desiredValue)}
                    </p>
                    <p className="settings__value" data-testid={`settings-effective-${namespace}`}>
                      本实例当前生效：{snapshotValue.effectiveValue === null ? "未应用" : JSON.stringify(snapshotValue.effectiveValue)}
                    </p>
                  </div>
                )}

                {!editing && snapshotValue !== null && (
                  <button
                    type="button"
                    className="button button--small"
                    data-testid={`settings-edit-${namespace}`}
                    disabled={pending || !props.canWrite}
                    onClick={() => {
                      openEditor(namespace, snapshotValue.desiredRevision, snapshotValue.desiredValue);
                    }}
                  >
                    编辑并保存
                  </button>
                )}

                {editing && (
                  <form
                    className="settings__form"
                    data-testid={`settings-form-${namespace}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      setError(null);
                      const built = namespace === "host" ? hostValueOf(draft.host) : modelValueOf(draft.model);
                      if (!built.ok) {
                        setError(built.reason);
                        return;
                      }
                      const submitted = draft.version;
                      void props.onSave(namespace, built.value, draft.baseRevision).then((outcome) => {
                        // Only a *confirmed* save closes the draft, and only
                        // when the draft is still the one that was submitted:
                        // text typed while the call was in flight is the user's,
                        // and an unanswered save is not a saved value.
                        if (outcome.kind !== "confirmed") return;
                        setDraft((current) =>
                          current !== null && current.namespace === namespace && current.version === submitted
                            ? null
                            : current,
                        );
                      });
                    }}
                  >
                    {authorityChanged && (
                      <p className="panel__note" data-testid={`settings-rebase-${namespace}`}>
                        这份草稿属于另一个 Host 实例（草稿来自 {draft.hostInstanceId ?? "未知"}，当前是{" "}
                        {snapshot.description?.hostInstanceId ?? "未知"}）：即使版本号相同也不能直接保存。
                        请先读取当前 Host 的设置（下方可以放弃草稿），再重新编辑。
                      </p>
                    )}
                    {hostMoved && (
                      <p className="panel__note" data-testid={`settings-moved-${namespace}`}>
                        Host 上的设置在你编辑期间已经变化（当前 desired 修订 {desiredRevision ?? "未知"}，
                        你的草稿基于 {draft.baseRevision}）：不会自动覆盖你的草稿，也不会自动重载。
                      </p>
                    )}
                    {(hostMoved || authorityChanged) && (
                      <div className="settings__actions">
                        <button
                          type="button"
                          className="button button--small"
                          data-testid={`settings-reload-${namespace}`}
                          onClick={() => {
                            setDraft(null);
                            props.onRead(namespace);
                          }}
                        >
                          {authorityChanged ? "丢弃草稿并读取当前 Host 的设置" : "丢弃草稿并重新读取"}
                        </button>
                        <span className="panel__note">
                          {authorityChanged
                            ? "这份草稿不能写入当前 Host；读取之后可以基于当前 Host 的版本重新编辑。"
                            : "或者继续编辑下面的草稿（保存会用旧修订做 CAS，可能被拒绝）。"}
                        </span>
                      </div>
                    )}

                    {namespace === "host" ? (
                      <>
                        <label className="settings__label" htmlFor="settings-system-prompt">
                          系统提示词（systemPrompt）
                        </label>
                        <textarea
                          id="settings-system-prompt"
                          className="settings__input"
                          data-testid="settings-field-system-prompt"
                          rows={4}
                          value={draft.host.systemPrompt}
                          onChange={(event) => {
                            edit({ ...draft, host: { ...draft.host, systemPrompt: event.target.value } });
                          }}
                        />
                        <label className="settings__label" htmlFor="settings-max-steps">
                          loop.maxSteps（{MAX_STEPS_BOUND.min}–{MAX_STEPS_BOUND.max}）
                        </label>
                        <input
                          id="settings-max-steps"
                          className="settings__input"
                          data-testid="settings-field-max-steps"
                          value={draft.host.maxSteps}
                          onChange={(event) => {
                            edit({ ...draft, host: { ...draft.host, maxSteps: event.target.value } });
                          }}
                        />
                        <label className="settings__label" htmlFor="settings-max-attempts">
                          loop.maxModelAttempts（{MAX_MODEL_ATTEMPTS_BOUND.min}–{MAX_MODEL_ATTEMPTS_BOUND.max}）
                        </label>
                        <input
                          id="settings-max-attempts"
                          className="settings__input"
                          data-testid="settings-field-max-model-attempts"
                          value={draft.host.maxModelAttempts}
                          onChange={(event) => {
                            edit({ ...draft, host: { ...draft.host, maxModelAttempts: event.target.value } });
                          }}
                        />
                      </>
                    ) : (
                      <>
                        <label className="settings__label" htmlFor="settings-provider">
                          provider
                        </label>
                        <input
                          id="settings-provider"
                          className="settings__input"
                          data-testid="settings-field-provider"
                          value={draft.model.provider}
                          onChange={(event) => {
                            edit({ ...draft, model: { ...draft.model, provider: event.target.value } });
                          }}
                        />
                        <label className="settings__label" htmlFor="settings-model">
                          model
                        </label>
                        <input
                          id="settings-model"
                          className="settings__input"
                          data-testid="settings-field-model"
                          value={draft.model.model}
                          onChange={(event) => {
                            edit({ ...draft, model: { ...draft.model, model: event.target.value } });
                          }}
                        />
                        <label className="settings__label" htmlFor="settings-base-url">
                          baseURL（可选）
                        </label>
                        <input
                          id="settings-base-url"
                          className="settings__input"
                          data-testid="settings-field-base-url"
                          value={draft.model.baseURL}
                          onChange={(event) => {
                            edit({ ...draft, model: { ...draft.model, baseURL: event.target.value } });
                          }}
                        />
                        <label className="settings__label" htmlFor="settings-reserve">
                          outputReserveTokens（可选，正整数）
                        </label>
                        <input
                          id="settings-reserve"
                          className="settings__input"
                          data-testid="settings-field-output-reserve"
                          value={draft.model.outputReserveTokens}
                          onChange={(event) => {
                            edit({ ...draft, model: { ...draft.model, outputReserveTokens: event.target.value } });
                          }}
                        />
                        <label className="settings__label" htmlFor="settings-timeout">
                          timeoutMs（可选，正整数）
                        </label>
                        <input
                          id="settings-timeout"
                          className="settings__input"
                          data-testid="settings-field-timeout"
                          value={draft.model.timeoutMs}
                          onChange={(event) => {
                            edit({ ...draft, model: { ...draft.model, timeoutMs: event.target.value } });
                          }}
                        />
                      </>
                    )}

                    {error !== null && (
                      <p className="settings__error" data-testid={`settings-error-${namespace}`}>
                        {error}
                      </p>
                    )}
                    {dirty && (
                      <p className="panel__note" data-testid={`settings-dirty-${namespace}`}>
                        草稿尚未保存。保存是整体替换，只改变 desired。
                      </p>
                    )}
                    <div className="settings__actions">
                      <button
                        type="submit"
                        className="button button--small button--primary"
                        data-testid={`settings-save-${namespace}`}
                        disabled={pending || !canSave}
                      >
                        {pending ? "保存中…" : "保存（只改变 desired）"}
                      </button>
                      <button
                        type="button"
                        className="button button--small"
                        data-testid={`settings-cancel-${namespace}`}
                        onClick={() => {
                          setDraft(null);
                          setError(null);
                        }}
                      >
                        放弃草稿
                      </button>
                    </div>
                    <p className="panel__note">
                      保存成功只表示「已保存」。要让它生效需要重启 Host 进程，成功启动后再读取确认。
                    </p>
                  </form>
                )}
              </>
            )}
          </div>
        );
      })}
      <p className="panel__note">本页只编辑 Host 实际支持的封闭 schema；没有凭据、环境变量或任意键。</p>
    </section>
  );
}
