// DSH monitor: a live, read-only view of DeepSeek Harness agent sessions.
//
// Two producers may write state JSON (both optional, both tolerated missing,
// stale or invalid):
//   1. the DSH host plugin:  state/dsh-agents.json
//   2. the no-restart sidecar: state/dsh-sidecar.json
// Shape (dsh-plugin owns the authoritative schema in plugin/STATE-SCHEMA.md):
//   { schemaVersion, updatedMs,
//     host: { url?, terminalId?, herdr?, profile?, pid? },
//     sessions: [{ id, title, status, activity, updatedMs, cwd?, blockedReason? }] }
// This mod never starts, stops or changes anything: clicking a session focuses
// the DSH host terminal (when it runs in Herdr); the header link opens the web GUI.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, home, notify, props, readTextFile, run, shared, theme } from "herdr";

// The canonical state document written by every reporter (the dsh-herdr
// launcher and, if installed, the native DSH host plugin). Extra producers can
// be added by pane props, e.g. { "paths": ["/abs/other-state.json"] }.
const DEFAULT_PATHS = [
  `${home()}/.local/state/dsh-herdr/agents.json`,
];
const DEFAULT_URL = "http://127.0.0.1:3080";
const POLL_MS = 1000;
const FRESH_MS = 20000; // a heartbeat is expected at least this often
const LAUNCH_HINT = "dsh-herdr daemon";

const RANK = { blocked: 0, working: 1, idle: 2, done: 3, unknown: 4 };
const KNOWN = new Set(["working", "blocked", "idle", "done"]);

const labelOf = (path) => {
  const name = String(path).split("/").pop() ?? path;
  if (name === "agents.json") return "launcher";
  if (name === "dsh-agents.json") return "plugin";
  return name.replace(/\.sample\.json$/, "").replace(/\.json$/, "");
};

const num = (v) => {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) return Number(v);
  return null;
};

// Producers may write seconds or milliseconds; accept both.
const msOf = (v) => {
  const n = num(v);
  if (n == null) return null;
  return n < 1e12 ? n * 1000 : n;
};

const statusOf = (raw) => {
  const s = String(raw ?? "").trim().toLowerCase();
  return KNOWN.has(s) ? s : "unknown";
};

const httpUrl = (u) => (typeof u === "string" && /^https?:\/\/[^\s]+$/i.test(u) ? u : null);

const normSession = (raw, source) => {
  if (!raw || typeof raw !== "object" || raw.id == null) return null;
  const id = String(raw.id);
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id;
  const activity = typeof raw.activity === "string" ? raw.activity.trim() : typeof raw.msg === "string" ? raw.msg.trim() : "";
  return {
    id,
    source,
    title,
    status: statusOf(raw.status ?? raw.state),
    activity,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    blockedReason: typeof raw.blockedReason === "string" ? raw.blockedReason : "",
    updatedMs: msOf(raw.updatedMs ?? raw.updated_ms ?? raw.updatedAt),
    url: httpUrl(raw.url),
  };
};

function parseState(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function ageText(ms) {
  if (ms == null || !isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export default class DshMonitor extends View {
  init(_props, cx) {
    this.files = [];
    this.sessions = [];
    this.host = null;
    this.hostUrl = DEFAULT_URL;
    this.terminalId = null;
    this.live = false;
    this.staleFor = null;
    this.present = 0;
    this.polling = false;
    this.loaded = false;
    this.notified = new Map();
    this.lastNotify = 0;

    const fromProps = props()?.paths;
    const fromShared = shared("dsh.monitor.paths");
    const custom = Array.isArray(fromProps) ? fromProps : Array.isArray(fromShared) ? fromShared : null;
    this.paths = (custom ?? DEFAULT_PATHS).filter((p) => typeof p === "string" && p.length > 0);

    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    // Ages ("2m") and the freshness line go by themselves; data polls above.
    cx.timer.every(10000, (cx) => cx.notify());
    this.poll(cx);
  }

  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const files = [];
        for (const path of this.paths) files.push(await this.readOne(path));
        this.files = files;
        this.merge(Date.now());
        this.polling = false;
        cx.notify();
      } catch (_e) {
        // A bad read must never take the panel down; the next poll retries.
        this.polling = false;
      }
    });
  }

  async readOne(path) {
    const label = labelOf(path);
    let text = null;
    try {
      text = await readTextFile(path);
    } catch (_e) {
      // Unreadable (permissions, transient) is treated like absent; the label
      // in the footer tells them apart from "invalid".
      return { path, label, present: false, invalid: false, updatedMs: null, sessions: [], host: null };
    }
    if (text == null) {
      return { path, label, present: false, invalid: false, updatedMs: null, sessions: [], host: null };
    }
    const state = parseState(text);
    if (!state) {
      return { path, label, present: true, invalid: true, updatedMs: null, sessions: [], host: null };
    }
    const sessions = Array.isArray(state.sessions) ? state.sessions.map((s) => normSession(s, label)).filter(Boolean) : [];
    let host = state.host && typeof state.host === "object" ? { ...state.host } : null;
    // dsh-herdr writes the owning pane at the top level instead of host.terminalId.
    const pane = typeof state.pane === "string" && state.pane ? state.pane : typeof state.terminal === "string" ? state.terminal : null;
    if (pane && !host?.terminalId) host = { ...(host ?? {}), terminalId: pane };
    return {
      path,
      label,
      present: true,
      invalid: false,
      updatedMs: msOf(state.updatedMs ?? state.updated_ms ?? state.updatedAt) ?? msOf(host?.updatedMs),
      sessions,
      host,
    };
  }

  merge(now) {
    const files = (this.files ?? []).map((f, i) => ({
      ...f,
      order: i,
      fresh: Boolean(f.present && !f.invalid && f.updatedMs != null && now - f.updatedMs <= FRESH_MS),
    }));
    // Freshest producer first; on a tie the earlier path (the host plugin) wins.
    const ordered = [...files].sort(
      (a, b) => Number(b.fresh) - Number(a.fresh) || (b.updatedMs ?? 0) - (a.updatedMs ?? 0) || a.order - b.order,
    );

    const byId = new Map();
    for (const f of ordered) for (const s of f.sessions ?? []) {
      const previous = byId.get(s.id);
      if (!previous || (s.updatedMs ?? 0) > (previous.updatedMs ?? 0)) byId.set(s.id, s);
    }
    this.sessions = [...byId.values()].sort(
      (a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || (b.updatedMs ?? 0) - (a.updatedMs ?? 0) || a.title.localeCompare(b.title),
    );

    // Host facts: the freshest file's value wins, field by field (freshest first).
    let host = null;
    for (const f of ordered) {
      if (!f.host) continue;
      host = host ?? {};
      for (const [k, v] of Object.entries(f.host)) if (v != null && !(k in host)) host[k] = v;
    }
    if (host && Object.keys(host).length === 0) host = null;
    this.host = host;
    this.hostUrl = httpUrl(host?.url) ?? this.hostUrl ?? DEFAULT_URL;
    this.terminalId = typeof host?.terminalId === "string" && host.terminalId ? host.terminalId : null;

    this.present = files.filter((f) => f.present).length;
    const newest = files.reduce((m, f) => Math.max(m, f.updatedMs ?? 0), 0);
    this.live = files.some((f) => f.fresh);
    this.staleFor = this.present > 0 && newest > 0 && !this.live ? now - newest : null;

    // One low-key toast when a session turns blocked and no Herdr-rendered agent
    // covers it (host.herdr means herdr-core shows the attention itself).
    if (this.loaded && !host?.herdr) {
      for (const s of this.sessions) {
        if (s.status !== "blocked") continue;
        const last = this.notified.get(s.id);
        if (last != null && (s.updatedMs ?? 0) <= last) continue;
        this.notified.set(s.id, s.updatedMs ?? now);
        if (now - this.lastNotify < 15000) continue;
        this.lastNotify = now;
        notify({ title: "DeepSeek Harness", body: `${s.title}${s.activity ? ` — ${s.activity}` : " needs you"}`, level: "info", timeout: 6000 });
      }
    }
    this.loaded = true;
  }

  // Clicking a session goes to its host terminal when Herdr runs it; otherwise
  // the only sensible target is the web GUI.
  focusHost(cx) {
    const term = this.terminalId;
    if (term) {
      const hit = (agents() ?? []).find((a) => a.address === term || a.address.split("/").pop() === term);
      if (hit) {
        run("pane.focus", { terminal: hit.address });
        return;
      }
    }
    this.openWeb(cx);
  }

  openWeb(cx) {
    if (this.hostUrl) cx.open_url(this.hostUrl);
  }

  glyph(t, status) {
    // Native motion for working; static marks for the rest. No timers.
    if (status === "working") {
      return svg("mods/dsh-monitor/spinner.svg").size(14).mx(1).flex_none().text_color(t.working).spin(900);
    }
    if (status === "blocked") {
      return div()
        .size(15)
        .flex_none()
        .rounded(5)
        .bg(`${t.blocked}26`)
        .text_size(10.5)
        .font_bold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .justify_center()
        .child("!");
    }
    if (status === "idle") {
      return div().size(8).mx(3.5).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    }
    if (status === "done") {
      return div().size(8).mx(3.5).flex_none().rounded(4).bg(t.done ?? t.dim);
    }
    return div().size(8).mx(3.5).flex_none().rounded(4).bg(t.dim);
  }

  chip(t, color, label, count) {
    return h_flex()
      .gap(5)
      .items_center()
      .child(div().size(6).flex_none().rounded(3).bg(color))
      .child(div().text_color(t.muted).child(`${count} ${label}`));
  }

  header(t, counts) {
    const link = div()
      .id("dsh-web")
      .text_size(11)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.text_color(t.accent))
      .tooltip(this.hostUrl)
      .on_click((_e, cx) => this.openWeb(cx))
      .child("web GUI");

    const fresh = this.live
      ? h_flex().gap(5).items_center().child(div().size(6).flex_none().rounded(3).bg(t.working)).child(div().text_color(t.muted).child("live"))
      : h_flex()
          .gap(5)
          .items_center()
          .child(div().size(6).flex_none().rounded(3).bg(t.dim))
          .child(div().text_color(t.dim).child(this.present === 0 ? "no watcher state" : `stale ${ageText(this.staleFor)}`));

    return v_flex()
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .px(12)
          .pt(10)
          .pb(6)
          .gap(8)
          .items_center()
          .child(svg("mods/dsh-monitor/dsh-tui.svg").size(19).flex_none().text_color(t.accent))
          .child(div().text_size(13.5).font_semibold().child("DeepSeek Harness"))
          .child(div().flex_1())
          .child(link),
      )
      .child(
        h_flex()
          .px(12)
          .pb(9)
          .gap(12)
          .items_center()
          .text_size(11)
          .child(fresh)
          .when(counts.blocked > 0, (el) => el.child(this.chip(t, t.blocked, "needs you", counts.blocked)))
          .when(counts.working > 0, (el) => el.child(this.chip(t, t.working, "working", counts.working)))
          .when(counts.idle + counts.unknown > 0, (el) => el.child(this.chip(t, t.idle ?? t.dim, "idle", counts.idle + counts.unknown)))
          .when(counts.done > 0, (el) => el.child(this.chip(t, t.done ?? t.dim, "done", counts.done))),
      );
  }

  row(t, s, now) {
    const blocked = s.status === "blocked";
    const detail = blocked
      ? s.blockedReason
        ? `needs you: ${s.blockedReason}`
        : "needs your attention"
      : s.activity || s.cwd || "—";
    return h_flex()
      .id(`dsh-${s.id}`)
      .px(8)
      .py(6)
      .rounded(8)
      .gap(8)
      .items_start()
      .when(blocked, (el) => el.bg(`${t.blocked}12`))
      .hover((el) => el.bg(t.hover))
      .cursor_pointer()
      .tooltip(this.terminalId ? "Focus the DSH host terminal" : "Open the DSH web GUI")
      .on_click((_e, cx) => this.focusHost(cx))
      .child(this.glyph(t, s.status))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().flex_1().min_w(0).truncate().text_color(blocked ? t.foreground : t.foreground).child(s.title))
              .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ageText(now - (s.updatedMs ?? now)))),
          )
          .child(
            div()
              .truncate()
              .text_size(11)
              .text_color(blocked ? t.blocked : s.activity ? t.muted : t.dim)
              .child(detail),
          ),
      );
  }

  list(t, now, counts) {
    if (this.sessions.length === 0) {
      const absent = this.present === 0;
      return v_flex()
        .flex_1()
        .min_h(0)
        .items_center()
        .justify_center()
        .gap(6)
        .px(18)
        .child(div().text_size(12.5).text_color(t.muted).child(absent ? "DSH agent not running" : "No DSH sessions"))
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(absent ? "No DSH reporter is running. Start it:" : "Open the web GUI and start a task."),
        )
        .when(absent, (el) =>
          el
            .child(div().px(8).py(3).rounded(5).bg(t.raised).text_size(11.5).text_color(t.foreground).child(LAUNCH_HINT))
            .child(div().text_size(10.5).text_color(t.dim).child("in a terminal, then this panel goes live")),
        )
        .when(this.present > 0 && this.sessions.length === 0, (el) =>
          el.child(div().text_size(10.5).text_color(t.dim).child("state file is present but lists no sessions")),
        );
    }
    return v_flex()
      .id("dsh-list")
      .flex_1()
      .min_h(0)
      .px(6)
      .py(4)
      .gap(1)
      .overflow_y_scrollbar()
      .mode("always")
      .children(this.sessions.map((s) => this.row(t, s, now)));
  }

  footer(t) {
    const source = (f) => {
      const color = f.invalid ? t.blocked : f.present ? (f.fresh ? t.working : t.dim) : `${t.dim}66`;
      const what = f.invalid ? "invalid" : f.present ? ageText(Date.now() - (f.updatedMs ?? 0)) : "absent";
      return h_flex()
        .id(`dsh-src-${f.label}`)
        .gap(4)
        .items_center()
        .tooltip(f.path)
        .child(div().size(5).flex_none().rounded(3).bg(color))
        .child(div().text_color(f.present || f.invalid ? t.dim : `${t.dim}99`).child(`${f.label} ${what}`));
    };
    return h_flex()
      .flex_none()
      .px(12)
      .py(6)
      .gap(10)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .text_size(10.5)
      // Only producers that actually exist are listed; absent optional sources
      // (the native plugin, the dev sidecar) are not noise in the footer.
      .children((this.files ?? []).filter((f) => f.present || f.invalid).map(source))
      .child(div().flex_1())
      .child(div().text_color(`${t.dim}99`).child(this.hostUrl.replace(/^https?:\/\//, "")));
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const counts = { blocked: 0, working: 0, idle: 0, done: 0, unknown: 0 };
    for (const s of this.sessions ?? []) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.surface)
      .text_size(13)
      .text_color(t.foreground)
      .child(this.header(t, counts))
      .child(this.list(t, now, counts))
      .child(this.footer(t));
  }
}
