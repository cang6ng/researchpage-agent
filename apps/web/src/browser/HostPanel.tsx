/**
 * Who this page is talking to, and what that host promises about remembering.
 *
 * The card repeats the host's own description — name, version, instance,
 * capabilities and limits — and states the retention fact from the host's own
 * declaration rather than from a hard-coded sentence: `durable` means committed
 * sessions and history live in a persistent backend and can be read back after
 * a restart, `ephemeral` means they live exactly as long as this process. Both
 * are said next to the half that is true in either mode: live output, a pending
 * approval and a prepared execution are memory, and no restart resumes them.
 */

import type { ClientSnapshot } from "@every-dagent/client";

import { retentionView, shortId } from "./presentation.js";

export interface HostPanelProps {
  readonly snapshot: ClientSnapshot;
}

export function HostPanel(props: HostPanelProps) {
  const description = props.snapshot.description;
  const retention = retentionView(description);

  return (
    <section className="panel" data-testid="host-panel">
      <header className="panel__head">
        <h2>Host</h2>
      </header>
      {description === null || retention === null ? (
        <p className="empty" data-testid="host-empty">
          还没有连接到任何 Host。
        </p>
      ) : (
        <>
          <p className="panel__detail">
            {description.host.name} v{description.host.version} · 协议 {description.protocolVersion}
          </p>
          <p className="panel__detail" data-testid="host-instance">
            实例 {shortId(description.hostInstanceId)}
          </p>
          <p className="panel__detail" data-testid="host-limits">
            并发运行上限 {description.limits.maxActiveRuns}
          </p>
          <p className="panel__detail" data-testid="host-capabilities">
            能力：
            {Object.entries(description.capabilities)
              .filter(([, supported]) => supported)
              .map(([name]) => name)
              .join(", ")}
          </p>
          <p
            className={retention.durable ? "panel__note" : "panel__note panel__note--warn"}
            data-testid="host-retention"
            data-retention={description.storage.retention}
          >
            {retention.headline}
          </p>
          {retention.details.map((detail) => (
            <p className="panel__note" key={detail} data-testid="host-retention-detail">
              {detail}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
