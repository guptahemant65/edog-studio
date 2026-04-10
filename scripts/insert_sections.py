#!/usr/bin/env python3
"""One-shot script to insert sections 17-20 into the design bible."""
import pathlib
import sys

FILE = pathlib.Path(
    r"C:\Users\guptahemant\.copilot\session-state"
    r"\0a0cfa6f-d2d8-4b53-9f2f-e1dba9df4ca7\files\design-bible.html"
)

# ─────────────────────────────────────────────
# 1. New CSS for sections 17-20
# ─────────────────────────────────────────────
NEW_CSS = """
<style>
/* ── S17: Data-Heavy Components ── */
.ctx-demo-area{position:relative;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-md);padding:32px 24px;font-size:13px;color:var(--text-2);cursor:context-menu;user-select:none;text-align:center}
.ctx-demo-area.ctx-active{border-color:var(--accent)}
.ctx-menu{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg-3);border:1px solid var(--border-2);border-radius:var(--r-md);box-shadow:var(--shadow-xl);padding:4px 0;min-width:180px;z-index:10;display:none}
.ctx-menu.visible{display:block}
.ctx-item{display:flex;align-items:center;gap:10px;padding:7px 14px;font-size:13px;color:var(--text);cursor:pointer;transition:background var(--t-fast)}
.ctx-item:hover{background:var(--bg-4)}
.ctx-item .ctx-ico{width:16px;height:16px;color:var(--text-3);flex-shrink:0}
.ctx-item.ctx-danger{color:var(--red)}
.ctx-item.ctx-danger .ctx-ico{color:var(--red)}
.ctx-sep{height:1px;background:var(--border);margin:4px 0}
.ctx-item kbd{margin-left:auto;font-size:10px;background:var(--bg-4);border:1px solid var(--border);border-radius:3px;padding:1px 5px;color:var(--text-3)}

.breadcrumb{display:flex;align-items:center;gap:0;flex-wrap:wrap}
.bc-seg{font-size:13px;color:var(--text-2);cursor:pointer;padding:3px 6px;border-radius:var(--r-sm);transition:background var(--t-fast),color var(--t-fast)}
.bc-seg:hover{background:var(--bg-4);color:var(--text)}
.bc-seg.bc-current{color:var(--text);font-weight:600;cursor:default}
.bc-seg.bc-current:hover{background:transparent}
.bc-sep{color:var(--text-4);font-size:11px;padding:0 2px;user-select:none}
.bc-overflow{display:flex;align-items:center;gap:0}
.bc-more{background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-sm);font-size:12px;color:var(--text-2);padding:2px 8px;cursor:pointer;line-height:1.4;transition:background var(--t-fast)}
.bc-more:hover{background:var(--bg-4)}

.filter-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.filter-search{flex:1;min-width:160px;display:flex;align-items:center;gap:8px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-md);padding:0 10px;height:32px}
.filter-search input{background:transparent;border:none;outline:none;font-size:13px;color:var(--text);width:100%}
.filter-search input::placeholder{color:var(--text-4)}
.filter-search svg{color:var(--text-3);flex-shrink:0}
.filter-pills{display:flex;gap:6px;flex-wrap:wrap}
.filter-pill{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:var(--r-pill);font-size:12px;font-weight:600;border:1px solid var(--border-2);background:var(--bg-3);color:var(--text-2);cursor:pointer;transition:all var(--t-fast)}
.filter-pill:hover{border-color:var(--accent);color:var(--accent)}
.filter-pill.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.filter-pill .pill-x{margin-left:2px;opacity:.7;font-size:14px}
.filter-count{font-size:12px;color:var(--text-3);white-space:nowrap;padding:0 4px}

.exp-table{width:100%;border-collapse:collapse}
.exp-table th{text-align:left;font-size:11px;font-weight:700;color:var(--text-3);padding:0 12px 8px;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.exp-row td{padding:10px 12px;font-size:13px;color:var(--text);border-bottom:1px solid var(--border);vertical-align:top}
.exp-row:last-child td{border-bottom:none}
.exp-row .exp-toggle{cursor:pointer;user-select:none;display:flex;align-items:center;gap:8px}
.exp-arrow{display:inline-block;font-size:10px;color:var(--text-3);transition:transform var(--t-normal);line-height:1}
.exp-row.open .exp-arrow{transform:rotate(90deg)}
.exp-detail{display:none;background:var(--bg-3);border-radius:var(--r-md);padding:12px;margin-top:6px;font-family:monospace;font-size:11px;color:var(--code-text);line-height:1.6;white-space:pre-wrap;word-break:break-all}
.exp-row.open .exp-detail{display:block}

.msel-list{border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden}
.msel-item{display:flex;align-items:center;gap:10px;padding:9px 14px;font-size:13px;color:var(--text);cursor:pointer;border-bottom:1px solid var(--border);transition:background var(--t-fast)}
.msel-item:last-child{border-bottom:none}
.msel-item:hover{background:var(--bg-3)}
.msel-item.selected{background:var(--accent-dim)}
.msel-cb{width:16px;height:16px;border-radius:4px;border:2px solid var(--border-2);flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all var(--t-fast)}
.msel-item.selected .msel-cb{background:var(--accent);border-color:var(--accent)}
.msel-item.selected .msel-cb::after{content:'✓';font-size:10px;color:#fff;font-weight:700}
.msel-batch{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--accent-dim);border-radius:var(--r-md);margin-top:8px;font-size:12px;color:var(--accent);font-weight:600}

.tr-pills{display:flex;gap:4px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-pill);padding:3px;width:fit-content}
.tr-pill{padding:5px 14px;border-radius:var(--r-pill);font-size:12px;font-weight:600;color:var(--text-3);cursor:pointer;transition:all var(--t-fast)}
.tr-pill.active{background:var(--bg);color:var(--text);box-shadow:var(--shadow-sm)}
.tr-custom{display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap}
.tr-input{background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-md);padding:6px 10px;font-size:12px;color:var(--text);outline:none;transition:border-color var(--t-fast);font-family:monospace}
.tr-input:focus{border-color:var(--accent)}

/* ── S18: Real-Time & Status ── */
.ws-widget{background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-lg);padding:16px}
.ws-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.ws-title{font-size:13px;font-weight:700;color:var(--text);flex:1}
.ws-state{display:flex;gap:6px}
.ws-state-btn{font-size:11px;font-weight:700;padding:3px 10px;border-radius:var(--r-pill);border:1px solid var(--border);background:var(--bg-3);color:var(--text-3);cursor:pointer;transition:all var(--t-fast)}
.ws-state-btn.ws-connected{border-color:var(--green);color:var(--green);background:var(--green-dim)}
.ws-state-btn.ws-paused{border-color:var(--amber);color:var(--amber);background:var(--amber-dim)}
.ws-state-btn.ws-disconnected{border-color:var(--red);color:var(--red);background:var(--red-dim)}
.ws-stats{display:flex;gap:16px;margin-bottom:10px}
.ws-stat{font-size:11px;color:var(--text-3)}.ws-stat span{color:var(--text);font-weight:700;font-family:monospace}
.ws-sparkline{display:flex;align-items:flex-end;gap:2px;height:40px}
.ws-bar{width:12px;background:var(--accent);border-radius:2px 2px 0 0;opacity:.7;transition:height var(--t-normal)}
.ws-bar.ws-peak{background:var(--green);opacity:1}

.vscroll-minimap{width:14px;border-radius:7px;background:var(--bg-3);border:1px solid var(--border);position:relative;overflow:hidden;cursor:pointer}
.vscroll-track{position:absolute;inset:0;border-radius:7px}
.vscroll-dot{position:absolute;width:10px;left:2px;height:3px;border-radius:1px;background:var(--text-4)}
.vscroll-dot.vscroll-err{background:var(--red)}
.vscroll-dot.vscroll-warn{background:var(--amber)}
.vscroll-thumb{position:absolute;width:10px;left:2px;background:rgba(109,92,255,.5);border-radius:3px;transition:top var(--t-fast)}
.vscroll-wrap{display:flex;gap:8px}
.vscroll-log{flex:1;font-family:monospace;font-size:11px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-md);padding:8px;height:120px;overflow:hidden}
.vscroll-log-line{color:var(--text-3);line-height:1.6}
.vscroll-log-line.vscroll-log-err{color:var(--red)}
.vscroll-log-line.vscroll-log-warn{color:var(--amber)}

.s-timeline{position:relative;padding:16px 0}
.s-track{position:absolute;top:50%;left:0;right:0;height:2px;background:var(--border);z-index:0;margin-top:8px}
.s-track-fill{position:absolute;left:0;height:100%;background:var(--accent);transition:width var(--t-smooth)}
.s-phases{position:relative;display:flex;justify-content:space-between;z-index:1}
.s-phase{display:flex;flex-direction:column;align-items:center;gap:6px}
.s-phase-dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--border-2);background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;transition:all var(--t-normal);cursor:default}
.s-phase-dot.sp-done{background:var(--green);border-color:var(--green);color:#fff}
.s-phase-dot.sp-active{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 0 0 4px var(--accent-dim)}
.s-phase-dot.sp-pending{background:var(--bg-3);color:var(--text-4)}
.s-phase-lbl{font-size:10px;font-weight:600;color:var(--text-3);text-align:center;white-space:nowrap}
.s-phase.sp-done .s-phase-lbl{color:var(--green)}
.s-phase.sp-active .s-phase-lbl{color:var(--accent)}

.lock-card{border:1.5px solid var(--border-2);border-radius:var(--r-lg);padding:20px;display:flex;align-items:center;gap:16px;cursor:pointer;transition:all var(--t-smooth);background:var(--bg-2)}
.lock-card:hover{border-color:var(--accent);box-shadow:var(--shadow-md)}
.lock-card.locked{border-color:var(--amber);background:var(--amber-dim)}
.lock-card.locked .lock-ico{color:var(--amber)}
.lock-card.unlocked{border-color:var(--green);background:var(--green-dim)}
.lock-card.unlocked .lock-ico{color:var(--green)}
.lock-ico{width:24px;height:24px;flex-shrink:0;color:var(--amber)}
.lock-title{font-size:14px;font-weight:700;color:var(--text)}
.lock-desc{font-size:12px;color:var(--text-3);margin-top:2px}
.lock-hint{margin-left:auto;font-size:11px;color:var(--text-4);font-style:italic}

.gauge-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
.gauge-svg{overflow:visible}
.gauge-track{fill:none;stroke:var(--border);stroke-width:10;stroke-linecap:round}
.gauge-fill{fill:none;stroke:var(--accent);stroke-width:10;stroke-linecap:round;transition:stroke-dashoffset var(--t-smooth)}
.gauge-label{font-size:22px;font-weight:800;fill:var(--text)}
.gauge-sub{font-size:11px;fill:var(--text-3)}
.gauge-slider{width:160px;accent-color:var(--accent)}

.anim-num-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.anim-num-card{background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-md);padding:14px;text-align:center}
.anim-num-val{font-size:28px;font-weight:800;font-family:monospace;color:var(--text);line-height:1.1;transition:color var(--t-fast)}
.anim-num-val.up{color:var(--green)}
.anim-num-val.down{color:var(--red)}
.anim-num-lbl{font-size:11px;color:var(--text-3);margin-top:4px;font-weight:600}

.ff-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}
.ff-row:last-child{border-bottom:none}
.ff-name{font-size:13px;font-weight:600;color:var(--text);min-width:120px}
.ff-rollout{flex:1;display:flex;align-items:center;gap:8px}
.ff-bar{flex:1;height:6px;background:var(--bg-3);border-radius:var(--r-pill);overflow:hidden}
.ff-bar-fill{height:100%;background:var(--accent);border-radius:var(--r-pill);transition:width var(--t-smooth)}
.ff-pct{font-size:11px;color:var(--text-3);font-family:monospace;min-width:32px}
.ff-envs{display:flex;gap:4px}
.ff-env{width:18px;height:18px;border-radius:50%;background:var(--bg-3);border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:var(--text-4);cursor:default}
.ff-env.ff-on{background:var(--green);border-color:var(--green);color:#fff}
.ff-env.ff-off{background:var(--bg-3);border-color:var(--border)}
.ff-override{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-3);margin-left:8px}
.toggle-sm{width:28px;height:16px;border-radius:8px;background:var(--border-2);cursor:pointer;position:relative;transition:background var(--t-fast);flex-shrink:0}
.toggle-sm.on{background:var(--accent)}
.toggle-sm::after{content:'';position:absolute;width:12px;height:12px;background:#fff;border-radius:50%;top:2px;left:2px;transition:left var(--t-fast)}
.toggle-sm.on::after{left:14px}

/* ── S19: Layout & Overflow ── */
.resize-wrap{display:flex;height:140px;border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;user-select:none}
.resize-pane{background:var(--bg-2);padding:12px;font-size:12px;color:var(--text-3);overflow:hidden}
.resize-divider{width:4px;background:var(--border-2);cursor:col-resize;flex-shrink:0;transition:background var(--t-fast)}
.resize-divider:hover,.resize-divider.dragging{background:var(--accent)}
.resize-divider-inner{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.resize-divider-dot{width:3px;height:3px;border-radius:50%;background:var(--text-4)}

.glass-outer{background:linear-gradient(135deg,oklch(50% .25 280),oklch(45% .2 220));border-radius:var(--r-xl);padding:24px;position:relative;overflow:hidden}
.glass-card{background:rgba(255,255,255,.08);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.18);border-radius:var(--r-lg);padding:16px 20px;position:relative;z-index:1}
.glass-title{font-size:14px;font-weight:700;color:#fff;margin-bottom:4px}
.glass-sub{font-size:12px;color:rgba(255,255,255,.6)}
.glass-stat{font-size:28px;font-weight:800;color:#fff;margin:8px 0 4px;font-family:monospace}
.glass-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.15);border-radius:var(--r-pill);padding:3px 10px;font-size:11px;font-weight:700;color:rgba(255,255,255,.9)}

.trunc-demos{display:flex;flex-direction:column;gap:10px}
.trunc-row{display:flex;flex-direction:column;gap:3px}
.trunc-lbl{font-size:10px;font-weight:700;color:var(--text-4);letter-spacing:.05em;text-transform:uppercase}
.trunc-end{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px;font-size:13px;color:var(--text-2);cursor:default}
.trunc-mid{max-width:280px;font-size:13px;color:var(--text-2);font-family:monospace;cursor:default}
.trunc-mid span{direction:rtl;unicode-bidi:bidi-override;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.trunc-ml{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:280px;font-size:13px;color:var(--text-2);line-height:1.5}
.trunc-tip{position:relative;display:inline-block}
.trunc-tip:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--bg-4);border:1px solid var(--border-2);border-radius:var(--r-sm);padding:4px 8px;font-size:11px;color:var(--text);white-space:nowrap;box-shadow:var(--shadow-md);z-index:99;pointer-events:none}

.layout-states{display:flex;gap:16px}
.layout-state-card{flex:1;border:1px solid var(--border);border-radius:var(--r-md);padding:12px;background:var(--bg-2)}
.layout-state-name{font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em}
.layout-diagram{display:flex;gap:4px;height:64px}
.ld-sidebar{width:28px;background:var(--accent-dim);border-radius:var(--r-sm);border:1px solid var(--accent);opacity:.7}
.ld-main{flex:1;background:var(--bg-3);border-radius:var(--r-sm);border:1px solid var(--border-2)}
.ld-panel{width:36px;background:var(--green-dim);border-radius:var(--r-sm);border:1px solid var(--green);opacity:.7}
.ld-sidebar.ld-hidden,.ld-panel.ld-hidden{display:none}
.ld-sidebar.ld-icon{width:16px;background:var(--accent-dim)}

.err-boundary{text-align:center;padding:32px 16px;background:var(--red-dim);border:1.5px dashed var(--red);border-radius:var(--r-lg)}
.err-b-ico{font-size:32px;margin-bottom:8px;color:var(--red)}
.err-b-title{font-size:14px;font-weight:700;color:var(--red);margin-bottom:4px}
.err-b-msg{font-size:12px;color:var(--text-3);margin-bottom:16px;font-family:monospace;background:var(--bg-2);padding:6px 10px;border-radius:var(--r-sm);display:inline-block;text-align:left}
.err-b-btns{display:flex;gap:8px;justify-content:center}

.load-comp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.load-state-card{border:1px solid var(--border);border-radius:var(--r-md);padding:12px;background:var(--bg-2)}
.load-state-lbl{font-size:10px;font-weight:700;color:var(--text-4);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
.skel-line{height:10px;background:var(--bg-3);border-radius:var(--r-pill);margin-bottom:7px;animation:skel-pulse 1.4s ease-in-out infinite}
.skel-circle{width:32px;height:32px;border-radius:50%;background:var(--bg-3);margin-bottom:7px;animation:skel-pulse 1.4s ease-in-out infinite}
.skel-block{height:48px;background:var(--bg-3);border-radius:var(--r-sm);animation:skel-pulse 1.4s ease-in-out infinite}
@keyframes skel-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.load-ready .skel-line,.load-ready .skel-circle,.load-ready .skel-block{animation:none;background:transparent;border:1px solid transparent}
.load-ready .skel-line{height:10px;background:var(--bg-3)}

/* ── S20: Domain-Specific ── */
.err-code-trigger{cursor:pointer;display:inline-flex;align-items:center;gap:8px;padding:8px 14px;background:var(--red-dim);border:1.5px solid var(--red);border-radius:var(--r-md);font-size:13px;font-weight:700;color:var(--red);transition:all var(--t-fast)}
.err-code-trigger:hover{background:var(--red);color:#fff}
.err-code-popover{background:#0f0f1a;border:1px solid #2d2d45;border-radius:var(--r-lg);padding:16px;margin-top:8px;display:none;box-shadow:var(--shadow-xl)}
.err-code-popover.visible{display:block}
.err-pop-code{font-size:10px;font-weight:700;color:var(--red);letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
.err-pop-title{font-size:13px;font-weight:700;color:#e2e2f0;margin-bottom:10px}
.err-pop-section{font-size:10px;font-weight:700;color:#6c7086;letter-spacing:.06em;text-transform:uppercase;margin:10px 0 4px}
.err-pop-item{display:flex;align-items:baseline;gap:8px;font-size:12px;color:#a6a6c0;margin-bottom:4px;line-height:1.5}
.err-pop-item::before{content:'▸';color:#6d5cff;font-size:10px;flex-shrink:0}
.err-pop-fix{background:#1a1a2e;border:1px solid #2d2d45;border-radius:var(--r-sm);padding:8px 10px;font-size:11px;font-family:monospace;color:#a6e3a1;margin-top:4px;word-break:break-all}

.nb-cell{border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;background:var(--bg-2)}
.nb-toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--bg-3);border-bottom:1px solid var(--border)}
.nb-gutter{width:32px;font-size:10px;font-weight:700;color:var(--text-4);text-align:center;font-family:monospace}
.nb-cell-type{font-size:10px;font-weight:700;color:var(--text-3);letter-spacing:.04em;text-transform:uppercase;flex:1}
.nb-code{background:var(--code-bg);padding:10px 12px;font-family:monospace;font-size:12px;line-height:1.7;overflow-x:auto}
.nb-kw{color:var(--code-kw)}
.nb-str{color:var(--code-str)}
.nb-fn{color:var(--code-type)}
.nb-cmt{color:var(--code-cmt)}
.nb-out{border-top:1px solid var(--border);padding:10px 12px}
.nb-out-table{width:100%;border-collapse:collapse;font-size:12px;font-family:monospace}
.nb-out-table th{text-align:left;font-size:10px;font-weight:700;color:var(--text-3);padding:0 8px 6px;border-bottom:1px solid var(--border)}
.nb-out-table td{padding:5px 8px;color:var(--text);border-bottom:1px solid var(--border)}
.nb-out-table tr:last-child td{border-bottom:none}
.nb-run-btn{margin-left:auto;display:flex;align-items:center;gap:5px;padding:4px 10px;background:var(--accent);border-radius:var(--r-sm);font-size:11px;font-weight:700;color:#fff;cursor:pointer;border:none;transition:background var(--t-fast)}
.nb-run-btn:hover{background:oklch(52% .25 280)}

.diff-view{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;font-family:monospace;font-size:12px}
.diff-col{overflow:hidden}
.diff-header{padding:6px 12px;background:var(--bg-3);border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text-3);display:flex;align-items:center;gap:8px}
.diff-col:first-child .diff-header{border-right:1px solid var(--border)}
.diff-col:first-child .diff-line{border-right:1px solid var(--border)}
.diff-lines{background:var(--bg-2)}
.diff-line{display:flex;align-items:baseline;gap:0;line-height:1.7}
.diff-line-num{width:32px;text-align:right;padding:0 8px;font-size:10px;color:var(--text-4);flex-shrink:0;user-select:none;background:var(--bg-3)}
.diff-line-content{flex:1;padding:0 8px;white-space:pre-wrap;color:var(--text-2);word-break:break-all}
.diff-line.diff-add{background:var(--green-dim)}
.diff-line.diff-add .diff-line-num{background:rgba(24,160,88,.2);color:var(--green)}
.diff-line.diff-add .diff-line-content{color:var(--green)}
.diff-line.diff-del{background:var(--red-dim)}
.diff-line.diff-del .diff-line-num{background:rgba(229,69,59,.2);color:var(--red)}
.diff-line.diff-del .diff-line-content{color:var(--red)}
.diff-line.diff-ctx .diff-line-content{color:var(--text-3)}

.cp-wrap{background:var(--bg-3);border:1px solid var(--border-2);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow-xl)}
.cp-input-row{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)}
.cp-input-icon{color:var(--text-3)}
.cp-input{background:transparent;border:none;outline:none;font-size:14px;color:var(--text);flex:1}
.cp-input::placeholder{color:var(--text-4)}
.cp-kbd-hint{font-size:11px;color:var(--text-4)}
.cp-results{padding:6px 0}
.cp-group-lbl{font-size:10px;font-weight:700;color:var(--text-4);letter-spacing:.06em;text-transform:uppercase;padding:6px 16px 4px}
.cp-result{display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;transition:background var(--t-fast)}
.cp-result:hover,.cp-result.cp-active{background:var(--bg-4)}
.cp-result.cp-active{border-left:2px solid var(--accent);padding-left:14px}
.cp-result-ico{width:16px;height:16px;color:var(--text-3);flex-shrink:0}
.cp-result-text{flex:1;font-size:13px;color:var(--text)}
.cp-result-text mark{background:var(--accent-dim);color:var(--accent);border-radius:2px;padding:0 2px}
.cp-result-meta{font-size:11px;color:var(--text-4)}
.cp-footer{display:flex;align-items:center;gap:12px;padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-2)}
.cp-footer-key{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-4)}
.cp-footer-key kbd{background:var(--bg-3);border:1px solid var(--border-2);border-radius:3px;padding:1px 5px;font-size:10px;color:var(--text-3)}

.cap-card{border:1px solid var(--border);border-radius:var(--r-lg);padding:16px;background:var(--bg-2)}
.cap-card-header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.cap-card-title{font-size:13px;font-weight:700;color:var(--text);flex:1}
.cap-card-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:var(--r-pill)}
.cap-rows{display:flex;flex-direction:column;gap:10px}
.cap-row-lbl{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-2);margin-bottom:4px}
.cap-row-pct{font-family:monospace;font-size:11px;color:var(--text-3)}
.cap-bar{height:8px;background:var(--bg-3);border-radius:var(--r-pill);overflow:hidden}
.cap-bar-fill{height:100%;border-radius:var(--r-pill);transition:width var(--t-smooth)}
.cap-bar-fill.cap-ok{background:var(--green)}
.cap-bar-fill.cap-warn{background:var(--amber)}
.cap-bar-fill.cap-err{background:var(--red)}
.cap-bar-fill.cap-info{background:var(--accent)}

.session-entry{border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;background:var(--bg-2)}
.session-entry-header{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;transition:background var(--t-fast)}
.session-entry-header:hover{background:var(--bg-3)}
.session-arrow{font-size:10px;color:var(--text-3);transition:transform var(--t-normal)}
.session-entry.open .session-arrow{transform:rotate(90deg)}
.session-time{font-size:11px;font-family:monospace;color:var(--text-3);min-width:80px}
.session-op{font-size:13px;font-weight:600;color:var(--text);flex:1}
.session-dur{font-size:11px;color:var(--text-4);font-family:monospace}
.session-detail{display:none;padding:12px 16px;border-top:1px solid var(--border);background:var(--bg)}
.session-entry.open .session-detail{display:block}
.session-kv-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:12px}
.session-kv-key{color:var(--text-3);font-weight:600;white-space:nowrap}
.session-kv-val{color:var(--text);font-family:monospace;word-break:break-all}
.session-timeline{display:flex;align-items:center;gap:0;margin-top:12px}
.session-tl-dot{width:10px;height:10px;border-radius:50%;background:var(--accent);flex-shrink:0;z-index:1}
.session-tl-dot.tl-done{background:var(--green)}
.session-tl-dot.tl-err{background:var(--red)}
.session-tl-line{flex:1;height:2px;background:var(--border)}
.session-tl-lbl{font-size:9px;color:var(--text-4);white-space:nowrap;margin:0 4px}
</style>
"""

# ─────────────────────────────────────────────
# 2. New HTML sections
# ─────────────────────────────────────────────
NEW_HTML = r"""
<section class="section" id="s17">
  <div class="sec-hdr">
    <div class="sec-ico">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
        <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
      </svg>
    </div>
    <div>
      <div class="sec-num">Section 17</div>
      <div class="sec-title">Data-Heavy Components</div>
      <div class="sec-desc">Context menus, breadcrumbs, filter bars, expandable rows, multi-select lists, and time-range selectors for dense data workflows.</div>
    </div>
  </div>

  <!-- 17A: Context Menu -->
  <div class="demo">
    <span class="demo-tag">17A · CONTEXT MENU</span>
    <div class="sub-title">Right-click target area</div>
    <div class="ctx-demo-area" id="ctx-area">Right-click anywhere in this area to open the context menu.</div>
    <div class="ctx-menu" id="ctx-menu">
      <div class="ctx-item" onclick="ctxClose()">
        <svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Inspect Node<kbd>I</kbd>
      </div>
      <div class="ctx-item" onclick="ctxClose()">
        <svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Edit Value<kbd>E</kbd>
      </div>
      <div class="ctx-item" onclick="ctxClose()">
        <svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy Path<kbd>⌘C</kbd>
      </div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" onclick="ctxClose()">
        <svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export to JSON
      </div>
      <div class="ctx-sep"></div>
      <div class="ctx-item ctx-danger" onclick="ctxClose()">
        <svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        Delete Row
      </div>
    </div>
  </div>

  <!-- 17B: Breadcrumb -->
  <div class="demo mt16">
    <span class="demo-tag">17B · BREADCRUMB NAVIGATION</span>
    <div class="sub-title">Standard</div>
    <nav class="breadcrumb">
      <span class="bc-seg">Workspaces</span>
      <span class="bc-sep">›</span>
      <span class="bc-seg">FabricDev-WS</span>
      <span class="bc-sep">›</span>
      <span class="bc-seg">LiveTableLakehouse</span>
      <span class="bc-sep">›</span>
      <span class="bc-seg bc-current">Orders_Delta</span>
    </nav>
    <div class="sub-title mt16">With overflow collapse</div>
    <nav class="breadcrumb bc-overflow">
      <span class="bc-seg">Workspaces</span>
      <span class="bc-sep">›</span>
      <span class="bc-more" title="FabricDev-WS / LiveTableLakehouse / Schemas">&#8943;</span>
      <span class="bc-sep">›</span>
      <span class="bc-seg">dbo</span>
      <span class="bc-sep">›</span>
      <span class="bc-seg bc-current">Orders_Delta</span>
    </nav>
  </div>

  <!-- 17C: Filter Bar -->
  <div class="demo mt16">
    <span class="demo-tag">17C · FILTER BAR</span>
    <div class="filter-bar">
      <div class="filter-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" placeholder="Filter logs…" />
      </div>
      <div class="filter-pills">
        <span class="filter-pill active">Errors <span class="pill-x">✕</span></span>
        <span class="filter-pill active">Warnings <span class="pill-x">✕</span></span>
        <span class="filter-pill">Info</span>
        <span class="filter-pill">Debug</span>
      </div>
      <span class="filter-count">312 results</span>
    </div>
  </div>

  <!-- 17D+E: Expandable Rows + Multi-Select -->
  <div class="demo mt16 grid2">
    <div>
      <span class="demo-tag">17D · EXPANDABLE ROWS</span>
      <table class="exp-table">
        <thead><tr><th></th><th>Timestamp</th><th>Level</th><th>Source</th></tr></thead>
        <tbody>
          <tr class="exp-row" id="exp-r1">
            <td><div class="exp-toggle" onclick="expToggle('exp-r1')"><span class="exp-arrow">▶</span></div></td>
            <td class="mono" style="font-size:11px">14:32:01.441</td>
            <td><span class="badge b-err">ERR</span></td>
            <td>DAGExecutor</td>
          </tr>
          <tr><td colspan="4" style="padding:0 12px"><div class="exp-detail" id="exp-r1-detail">{"nodeId":"dag-node-7","error":"NullReferenceException","stack":"at FabricLiveTable.Execution.DagNode.Execute()","correlationId":"a3f9-cc21","retryAttempt":2}</div></td></tr>
          <tr class="exp-row" id="exp-r2">
            <td><div class="exp-toggle" onclick="expToggle('exp-r2')"><span class="exp-arrow">▶</span></div></td>
            <td class="mono" style="font-size:11px">14:32:05.102</td>
            <td><span class="badge b-warn">WRN</span></td>
            <td>SparkClient</td>
          </tr>
          <tr><td colspan="4" style="padding:0 12px"><div class="exp-detail" id="exp-r2-detail">{"sessionId":"spark-421","warning":"PartitionSkew","partition":3,"skewRatio":4.7,"recommendation":"Repartition to 16 buckets"}</div></td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <span class="demo-tag">17E · MULTI-SELECT LIST</span>
      <div class="msel-list" id="msel">
        <div class="msel-item" onclick="mselToggle(this)"><div class="msel-cb"></div><span>Orders_Delta</span></div>
        <div class="msel-item selected" onclick="mselToggle(this)"><div class="msel-cb"></div><span>Inventory_Stream</span></div>
        <div class="msel-item selected" onclick="mselToggle(this)"><div class="msel-cb"></div><span>Transactions_FLT</span></div>
        <div class="msel-item" onclick="mselToggle(this)"><div class="msel-cb"></div><span>Customers_Delta</span></div>
        <div class="msel-item" onclick="mselToggle(this)"><div class="msel-cb"></div><span>Products_Lookup</span></div>
      </div>
      <div class="msel-batch" id="msel-batch">
        <span>2 selected</span>
        <div style="flex:1"></div>
        <button class="btn btn-sm btn-success">Deploy</button>
        <button class="btn btn-sm btn-danger">Remove</button>
      </div>
    </div>
  </div>

  <!-- 17F: Time Range -->
  <div class="demo mt16">
    <span class="demo-tag">17F · TIME-RANGE SELECTOR</span>
    <div class="tr-pills" id="tr-pills">
      <span class="tr-pill active" data-val="15m" onclick="trSelect(this)">15m</span>
      <span class="tr-pill" data-val="1h" onclick="trSelect(this)">1h</span>
      <span class="tr-pill" data-val="6h" onclick="trSelect(this)">6h</span>
      <span class="tr-pill" data-val="24h" onclick="trSelect(this)">24h</span>
      <span class="tr-pill" data-val="7d" onclick="trSelect(this)">7d</span>
      <span class="tr-pill" data-val="custom" onclick="trSelect(this)">Custom</span>
    </div>
    <div class="tr-custom" id="tr-custom" style="display:none">
      <label style="font-size:12px;color:var(--text-3)">From</label>
      <input class="tr-input" type="datetime-local" value="2025-01-01T00:00" />
      <label style="font-size:12px;color:var(--text-3)">To</label>
      <input class="tr-input" type="datetime-local" value="2025-01-07T23:59" />
      <button class="btn btn-sm btn-pri">Apply</button>
    </div>
  </div>
</section>

<section class="section" id="s18">
  <div class="sec-hdr">
    <div class="sec-ico">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    </div>
    <div>
      <div class="sec-num">Section 18</div>
      <div class="sec-title">Real-Time &amp; Status</div>
      <div class="sec-desc">WebSocket throughput charts, virtual scroll minimap, deployment timelines, lock cards, capacity gauges, animated counters, and feature flag rows.</div>
    </div>
  </div>

  <!-- 18A+B: WS Throughput + Virtual Scroll Minimap -->
  <div class="demo grid2">
    <div>
      <span class="demo-tag">18A · WEBSOCKET THROUGHPUT</span>
      <div class="ws-widget">
        <div class="ws-header">
          <span class="ws-title">Event Stream</span>
          <div class="ws-state">
            <button class="ws-state-btn ws-connected" onclick="wsSetState(this,'connected')">Connected</button>
            <button class="ws-state-btn" onclick="wsSetState(this,'paused')">Paused</button>
            <button class="ws-state-btn" onclick="wsSetState(this,'disconnected')">Error</button>
          </div>
        </div>
        <div class="ws-stats">
          <div class="ws-stat">In: <span id="ws-in">847/s</span></div>
          <div class="ws-stat">Out: <span id="ws-out">12/s</span></div>
          <div class="ws-stat">Queue: <span id="ws-q">1,204</span></div>
          <div class="ws-stat">Dropped: <span id="ws-drop">0</span></div>
        </div>
        <div class="ws-sparkline" id="ws-sparkline"></div>
      </div>
    </div>
    <div>
      <span class="demo-tag">18B · VIRTUAL SCROLL MINIMAP</span>
      <div class="vscroll-wrap">
        <div class="vscroll-log" id="vscroll-log"></div>
        <div class="vscroll-minimap" id="vscroll-map" style="height:120px">
          <div class="vscroll-track" id="vscroll-track"></div>
          <div class="vscroll-thumb" id="vscroll-thumb" style="height:30px;top:0px"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- 18C: Status Timeline -->
  <div class="demo mt16">
    <span class="demo-tag">18C · DEPLOYMENT STATUS TIMELINE</span>
    <div class="s-timeline">
      <div class="s-track"><div class="s-track-fill" style="width:55%"></div></div>
      <div class="s-phases" id="s-phases">
        <div class="s-phase sp-done"><div class="s-phase-dot sp-done">✓</div><div class="s-phase-lbl">Build</div></div>
        <div class="s-phase sp-done"><div class="s-phase-dot sp-done">✓</div><div class="s-phase-lbl">Schema</div></div>
        <div class="s-phase sp-active"><div class="s-phase-dot sp-active">3</div><div class="s-phase-lbl">Deploy</div></div>
        <div class="s-phase sp-pending"><div class="s-phase-dot sp-pending">4</div><div class="s-phase-lbl">Verify</div></div>
        <div class="s-phase sp-pending"><div class="s-phase-dot sp-pending">5</div><div class="s-phase-lbl">Live</div></div>
      </div>
    </div>
  </div>

  <!-- 18D+E: Lock Card + Gauge -->
  <div class="demo mt16 grid2">
    <div>
      <span class="demo-tag">18D · LOCK STATUS CARD</span>
      <div class="lock-card locked" id="lock-card" onclick="lockToggle()">
        <svg class="lock-ico" id="lock-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <div>
          <div class="lock-title">Production Table</div>
          <div class="lock-desc">Locked by sana@microsoft.com · 12m ago</div>
        </div>
        <span class="lock-hint">Click to unlock</span>
      </div>
    </div>
    <div>
      <span class="demo-tag">18E · CAPACITY GAUGE</span>
      <div class="gauge-wrap">
        <svg class="gauge-svg" width="140" height="90" viewBox="0 0 140 90">
          <path class="gauge-track" d="M20,80 A60,60 0 0,1 120,80" />
          <path class="gauge-fill" id="gauge-path" d="M20,80 A60,60 0 0,1 120,80"
            stroke-dasharray="188.5" stroke-dashoffset="75" />
          <text class="gauge-label" x="70" y="78" text-anchor="middle" id="gauge-pct">60%</text>
          <text class="gauge-sub" x="70" y="90" text-anchor="middle">Spark VCores</text>
        </svg>
        <input type="range" class="gauge-slider" min="0" max="100" value="60" oninput="gaugeUpdate(this.value)" />
      </div>
    </div>
  </div>

  <!-- 18F: Animated Numbers -->
  <div class="demo mt16">
    <span class="demo-tag">18F · ANIMATED COUNTERS</span>
    <div class="anim-num-grid" id="anim-grid">
      <div class="anim-num-card"><div class="anim-num-val" id="an-0">0</div><div class="anim-num-lbl">Rows Ingested</div></div>
      <div class="anim-num-card"><div class="anim-num-val" id="an-1">0</div><div class="anim-num-lbl">Errors / min</div></div>
      <div class="anim-num-card"><div class="anim-num-val" id="an-2">0</div><div class="anim-num-lbl">Latency p99 (ms)</div></div>
    </div>
  </div>

  <!-- 18G: Feature Flag Rows -->
  <div class="demo mt16">
    <span class="demo-tag">18G · FEATURE FLAG ROWS</span>
    <div id="ff-rows">
      <div class="ff-row">
        <span class="ff-name">LiveViewV2</span>
        <div class="ff-rollout"><div class="ff-bar"><div class="ff-bar-fill" style="width:100%"></div></div><span class="ff-pct">100%</span></div>
        <div class="ff-envs"><span class="ff-env ff-on" title="Dev">D</span><span class="ff-env ff-on" title="Stage">S</span><span class="ff-env ff-on" title="Prod">P</span></div>
        <div class="ff-override"><span>Override</span><div class="toggle-sm on" onclick="this.classList.toggle('on')"></div></div>
      </div>
      <div class="ff-row">
        <span class="ff-name">SparkV3Client</span>
        <div class="ff-rollout"><div class="ff-bar"><div class="ff-bar-fill" style="width:40%"></div></div><span class="ff-pct">40%</span></div>
        <div class="ff-envs"><span class="ff-env ff-on" title="Dev">D</span><span class="ff-env ff-on" title="Stage">S</span><span class="ff-env ff-off" title="Prod">P</span></div>
        <div class="ff-override"><span>Override</span><div class="toggle-sm" onclick="this.classList.toggle('on')"></div></div>
      </div>
      <div class="ff-row">
        <span class="ff-name">DagStudioBeta</span>
        <div class="ff-rollout"><div class="ff-bar"><div class="ff-bar-fill" style="width:10%"></div></div><span class="ff-pct">10%</span></div>
        <div class="ff-envs"><span class="ff-env ff-on" title="Dev">D</span><span class="ff-env ff-off" title="Stage">S</span><span class="ff-env ff-off" title="Prod">P</span></div>
        <div class="ff-override"><span>Override</span><div class="toggle-sm" onclick="this.classList.toggle('on')"></div></div>
      </div>
    </div>
  </div>
</section>

<section class="section" id="s19">
  <div class="sec-hdr">
    <div class="sec-ico">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
      </svg>
    </div>
    <div>
      <div class="sec-num">Section 19</div>
      <div class="sec-title">Layout &amp; Overflow</div>
      <div class="sec-desc">Resizable panels, glass morphism cards, text truncation patterns, responsive layout states, error boundaries, and progressive loading compositions.</div>
    </div>
  </div>

  <!-- 19A: Resizable Panel -->
  <div class="demo">
    <span class="demo-tag">19A · RESIZABLE PANEL</span>
    <div class="sub-title">Drag the divider to resize</div>
    <div class="resize-wrap" id="resize-wrap">
      <div class="resize-pane" id="r-left" style="width:40%;min-width:80px"><strong style="color:var(--text)">File Explorer</strong><br>src/<br>tests/<br>scripts/</div>
      <div class="resize-divider" id="r-div"><div class="resize-divider-inner"><div class="resize-divider-dot"></div><div class="resize-divider-dot"></div><div class="resize-divider-dot"></div></div></div>
      <div class="resize-pane" id="r-right" style="flex:1;min-width:80px"><strong style="color:var(--text)">Editor</strong><br>Select a file to preview.</div>
    </div>
  </div>

  <!-- 19B+C: Glass Card + Truncation -->
  <div class="demo mt16 grid2">
    <div>
      <span class="demo-tag">19B · GLASS CARD</span>
      <div class="glass-outer">
        <div class="glass-card">
          <div class="glass-title">Lakehouse Health</div>
          <div class="glass-sub">FabricDev-WS · LiveTableLakehouse</div>
          <div class="glass-stat">99.7%</div>
          <div class="glass-badge">&#8679; 0.3% vs last week</div>
        </div>
      </div>
    </div>
    <div>
      <span class="demo-tag">19C · TRUNCATION PATTERNS</span>
      <div class="trunc-demos">
        <div class="trunc-row">
          <div class="trunc-lbl">End truncation</div>
          <div class="trunc-end" title="workspaces/FabricDev-WS/lakehouses/LiveTableLakehouse/tables/Orders_Delta_v2">workspaces/FabricDev-WS/lakehouses/LiveTableLakehouse/tables/Orders_Delta_v2</div>
        </div>
        <div class="trunc-row">
          <div class="trunc-lbl">Path truncation (middle)</div>
          <div class="trunc-mid"><span>…/lakehouses/LiveTableLakehouse/tables/Orders_Delta_v2</span></div>
        </div>
        <div class="trunc-row">
          <div class="trunc-lbl">Multi-line clamp (2 lines)</div>
          <div class="trunc-ml">FabricLiveTable is a real-time lakehouse streaming service that continuously materializes delta tables from event streams with sub-second latency and exactly-once semantics.</div>
        </div>
        <div class="trunc-row">
          <div class="trunc-lbl">Hover tooltip truncation</div>
          <div class="trunc-end trunc-tip" data-tip="Full: workspaces/FabricDev-WS/lakehouses/LiveTableLakehouse" style="cursor:default">workspaces/FabricDev-WS/lakehouses/LiveTable…</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 19D: Layout States -->
  <div class="demo mt16">
    <span class="demo-tag">19D · RESPONSIVE PANEL COLLAPSE STATES</span>
    <div class="layout-states">
      <div class="layout-state-card">
        <div class="layout-state-name">Wide (1200px+)</div>
        <div class="layout-diagram">
          <div class="ld-sidebar"></div>
          <div class="ld-main"></div>
          <div class="ld-panel"></div>
        </div>
        <div style="font-size:11px;color:var(--text-4);margin-top:6px">Sidebar + Main + Detail panel</div>
      </div>
      <div class="layout-state-card">
        <div class="layout-state-name">Medium (800–1199px)</div>
        <div class="layout-diagram">
          <div class="ld-sidebar ld-icon"></div>
          <div class="ld-main"></div>
        </div>
        <div style="font-size:11px;color:var(--text-4);margin-top:6px">Icon sidebar + Main (panel hidden)</div>
      </div>
      <div class="layout-state-card">
        <div class="layout-state-name">Narrow (&lt;800px)</div>
        <div class="layout-diagram">
          <div class="ld-main"></div>
        </div>
        <div style="font-size:11px;color:var(--text-4);margin-top:6px">Main only (sidebar overlay on demand)</div>
      </div>
    </div>
  </div>

  <!-- 19E+F: Error Boundary + Loading Composition -->
  <div class="demo mt16 grid2">
    <div>
      <span class="demo-tag">19E · ERROR BOUNDARY</span>
      <div class="err-boundary">
        <div class="err-b-ico">&#9888;</div>
        <div class="err-b-title">Component Crashed</div>
        <div class="err-b-msg">DagStudioView: Cannot read property<br>'nodes' of undefined</div>
        <div class="err-b-btns">
          <button class="btn btn-sm btn-danger">Retry</button>
          <button class="btn btn-sm btn-sec">Report</button>
        </div>
      </div>
    </div>
    <div>
      <span class="demo-tag">19F · LOADING COMPOSITION</span>
      <div class="load-comp-grid">
        <div class="load-state-card">
          <div class="load-state-lbl">Loading</div>
          <div class="skel-circle"></div>
          <div class="skel-line" style="width:80%"></div>
          <div class="skel-line" style="width:60%"></div>
          <div class="skel-block"></div>
        </div>
        <div class="load-state-card">
          <div class="load-state-lbl">Partial</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px"><div style="width:32px;height:32px;border-radius:50%;background:var(--bg-3);"></div><div style="flex:1"><div class="skel-line" style="width:90%;margin-bottom:4px"></div></div></div>
          <div class="skel-line" style="width:100%"></div>
          <div class="skel-line" style="width:75%"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><div class="skel-block" style="height:30px"></div><div class="skel-block" style="height:30px"></div></div>
        </div>
        <div class="load-state-card load-ready">
          <div class="load-state-lbl" style="color:var(--green)">Ready</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px"><div style="width:32px;height:32px;border-radius:50%;background:var(--accent-dim);border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--accent)">LT</div><div style="flex:1"><div style="font-size:12px;font-weight:700;color:var(--text)">LiveTable WS</div><div style="font-size:11px;color:var(--text-4)">3 tables active</div></div></div>
          <div style="font-size:12px;color:var(--text-2)">All systems operational</div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="section" id="s20">
  <div class="sec-hdr">
    <div class="sec-ico">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
      </svg>
    </div>
    <div>
      <div class="sec-num">Section 20</div>
      <div class="sec-title">Domain-Specific Components</div>
      <div class="sec-desc">Error code cards with diagnosis popovers, PySpark notebook cells, diff views, command palette results, capacity cards, and session history entries.</div>
    </div>
  </div>

  <!-- 20A+B: Error Code Card + Notebook Cell -->
  <div class="demo grid2">
    <div>
      <span class="demo-tag">20A · ERROR CODE CARD</span>
      <button class="err-code-trigger" onclick="errPopToggle()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        FLT-4012 · DAGExecutionFailed
      </button>
      <div class="err-code-popover" id="err-popover">
        <div class="err-pop-code">FLT-4012</div>
        <div class="err-pop-title">DAG execution failed due to unresolvable dependency cycle.</div>
        <div class="err-pop-section">Diagnosis</div>
        <div class="err-pop-item">Node <code style="background:#1a1a2e;padding:1px 4px;border-radius:3px;color:#89b4fa">dag-node-7</code> depends on <code style="background:#1a1a2e;padding:1px 4px;border-radius:3px;color:#89b4fa">dag-node-3</code> which creates a cycle.</div>
        <div class="err-pop-item">Detected during topological sort in <code style="background:#1a1a2e;padding:1px 4px;border-radius:3px;color:#cba6f7">DagScheduler.BuildExecutionPlan()</code></div>
        <div class="err-pop-section">Remediation</div>
        <div class="err-pop-item">Break the cycle by removing the back-edge dependency.</div>
        <div class="err-pop-fix">EXEC sp_configure 'dag_cycle_detection', 1;<br>-- Then re-run: edog dag validate --strict</div>
      </div>
    </div>
    <div>
      <span class="demo-tag">20B · NOTEBOOK CELL (PYSPARK)</span>
      <div class="nb-cell">
        <div class="nb-toolbar">
          <span class="nb-gutter">[1]</span>
          <span class="nb-cell-type">PySpark</span>
          <button class="nb-run-btn">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Run
          </button>
        </div>
        <div class="nb-code"><span class="nb-kw">from</span> pyspark.sql <span class="nb-kw">import</span> <span class="nb-type nb-fn">SparkSession</span>
<span class="nb-cmt"># Read the live table as a DataFrame</span>
df = spark.read.format(<span class="nb-str">"delta"</span>).<span class="nb-fn">load</span>(<span class="nb-str">"abfss://orders@datalake.dfs.core.windows.net"</span>)
df.<span class="nb-fn">filter</span>(df.status == <span class="nb-str">"PENDING"</span>).<span class="nb-fn">show</span>(<span class="nb-num" style="color:var(--code-num)">5</span>)</div>
        <div class="nb-out">
          <table class="nb-out-table">
            <thead><tr><th>order_id</th><th>status</th><th>total</th><th>ts</th></tr></thead>
            <tbody>
              <tr><td>ORD-8821</td><td>PENDING</td><td>142.50</td><td>2025-01-07</td></tr>
              <tr><td>ORD-8822</td><td>PENDING</td><td>89.99</td><td>2025-01-07</td></tr>
              <tr><td>ORD-8823</td><td>PENDING</td><td>204.00</td><td>2025-01-07</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- 20C: Diff View -->
  <div class="demo mt16">
    <span class="demo-tag">20C · DIFF VIEW (SIDE-BY-SIDE)</span>
    <div class="diff-view">
      <div class="diff-col">
        <div class="diff-header">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          main (before)
        </div>
        <div class="diff-lines">
          <div class="diff-line diff-ctx"><span class="diff-line-num">1</span><span class="diff-line-content">public class DagScheduler {</span></div>
          <div class="diff-line diff-del"><span class="diff-line-num">2</span><span class="diff-line-content">  private int maxRetries = 3;</span></div>
          <div class="diff-line diff-ctx"><span class="diff-line-num">3</span><span class="diff-line-content">  public void Execute() {</span></div>
          <div class="diff-line diff-del"><span class="diff-line-num">4</span><span class="diff-line-content">    var plan = BuildPlan();</span></div>
          <div class="diff-line diff-ctx"><span class="diff-line-num">5</span><span class="diff-line-content">    RunNodes(plan);</span></div>
          <div class="diff-line diff-ctx"><span class="diff-line-num">6</span><span class="diff-line-content">  }</span></div>
        </div>
      </div>
      <div class="diff-col">
        <div class="diff-header">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          feature/dag-retry (after)
        </div>
        <div class="diff-lines">
          <div class="diff-line diff-ctx"><span class="diff-line-num">1</span><span class="diff-line-content">public class DagScheduler {</span></div>
          <div class="diff-line diff-add"><span class="diff-line-num">2</span><span class="diff-line-content">  private int maxRetries = 5;</span></div>
          <div class="diff-line diff-ctx"><span class="diff-line-num">3</span><span class="diff-line-content">  public void Execute() {</span></div>
          <div class="diff-line diff-add"><span class="diff-line-num">4</span><span class="diff-line-content">    var plan = BuildPlanWithCycleCheck();</span></div>
          <div class="diff-line diff-ctx"><span class="diff-line-num">5</span><span class="diff-line-content">    RunNodes(plan);</span></div>
          <div class="diff-line diff-ctx"><span class="diff-line-num">6</span><span class="diff-line-content">  }</span></div>
        </div>
      </div>
    </div>
  </div>

  <!-- 20D: Command Palette -->
  <div class="demo mt16">
    <span class="demo-tag">20D · COMMAND PALETTE RESULTS</span>
    <div class="cp-wrap">
      <div class="cp-input-row">
        <svg class="cp-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="cp-input" type="text" value="dag" placeholder="Search commands, tables, views…" />
        <span class="cp-kbd-hint"><kbd style="background:var(--bg-4);border:1px solid var(--border-2);border-radius:3px;padding:1px 5px;font-size:10px">Esc</kbd> to close</span>
      </div>
      <div class="cp-results">
        <div class="cp-group-lbl">Commands</div>
        <div class="cp-result cp-active">
          <svg class="cp-result-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span class="cp-result-text">Open <mark>DAG</mark> Studio</span>
          <span class="cp-result-meta">&#8984;D</span>
        </div>
        <div class="cp-result">
          <svg class="cp-result-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          <span class="cp-result-text">Validate <mark>DAG</mark> Graph</span>
          <span class="cp-result-meta">Alt+V</span>
        </div>
        <div class="cp-group-lbl">Tables</div>
        <div class="cp-result">
          <svg class="cp-result-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
          <span class="cp-result-text">Orders_<mark>Dag</mark>Enriched</span>
          <span class="cp-result-meta">LiveTableLakehouse</span>
        </div>
      </div>
      <div class="cp-footer">
        <div class="cp-footer-key"><kbd>↑↓</kbd> Navigate</div>
        <div class="cp-footer-key"><kbd>↵</kbd> Select</div>
        <div class="cp-footer-key"><kbd>Esc</kbd> Dismiss</div>
      </div>
    </div>
  </div>

  <!-- 20E+F: Capacity Card + Session History -->
  <div class="demo mt16 grid2">
    <div>
      <span class="demo-tag">20E · CAPACITY CARD</span>
      <div class="cap-card">
        <div class="cap-card-header">
          <span class="cap-card-title">Spark Cluster Resources</span>
          <span class="badge b-warn cap-card-badge">Warn</span>
        </div>
        <div class="cap-rows">
          <div>
            <div class="cap-row-lbl"><span>vCores</span><span class="cap-row-pct">78%</span></div>
            <div class="cap-bar"><div class="cap-bar-fill cap-warn" style="width:78%"></div></div>
          </div>
          <div>
            <div class="cap-row-lbl"><span>Memory</span><span class="cap-row-pct">45%</span></div>
            <div class="cap-bar"><div class="cap-bar-fill cap-ok" style="width:45%"></div></div>
          </div>
          <div>
            <div class="cap-row-lbl"><span>Disk I/O</span><span class="cap-row-pct">91%</span></div>
            <div class="cap-bar"><div class="cap-bar-fill cap-err" style="width:91%"></div></div>
          </div>
          <div>
            <div class="cap-row-lbl"><span>Network</span><span class="cap-row-pct">12%</span></div>
            <div class="cap-bar"><div class="cap-bar-fill cap-info" style="width:12%"></div></div>
          </div>
        </div>
      </div>
    </div>
    <div>
      <span class="demo-tag">20F · SESSION HISTORY ENTRY</span>
      <div class="session-entry" id="sess-entry">
        <div class="session-entry-header" onclick="sessToggle()">
          <span class="session-arrow">▶</span>
          <span class="session-time">14:32:01</span>
          <span class="session-op">Deploy to LiveTableLakehouse</span>
          <span class="badge b-success" style="margin-left:4px">OK</span>
          <span class="session-dur">4.2s</span>
        </div>
        <div class="session-detail">
          <div class="session-kv-grid">
            <span class="session-kv-key">Workspace</span><span class="session-kv-val">FabricDev-WS</span>
            <span class="session-kv-key">Lakehouse</span><span class="session-kv-val">LiveTableLakehouse</span>
            <span class="session-kv-key">Tables</span><span class="session-kv-val">Orders_Delta, Inventory_Stream</span>
            <span class="session-kv-key">Duration</span><span class="session-kv-val">4.2s</span>
            <span class="session-kv-key">Triggered by</span><span class="session-kv-val">edog deploy --watch</span>
          </div>
          <div class="session-timeline" style="margin-top:12px">
            <div class="session-tl-dot tl-done"></div>
            <div class="session-tl-line"></div><div class="session-tl-lbl">Build</div>
            <div class="session-tl-line"></div>
            <div class="session-tl-dot tl-done"></div>
            <div class="session-tl-line"></div><div class="session-tl-lbl">Schema</div>
            <div class="session-tl-line"></div>
            <div class="session-tl-dot tl-done"></div>
            <div class="session-tl-line"></div><div class="session-tl-lbl">Deploy</div>
            <div class="session-tl-line"></div>
            <div class="session-tl-dot tl-done"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>
"""

# ─────────────────────────────────────────────
# 3. New JS block
# ─────────────────────────────────────────────
NEW_JS = """
<script>
(function() {
  'use strict';

  /* ── S17: Context Menu ── */
  var ctxArea = document.getElementById('ctx-area');
  var ctxMenu = document.getElementById('ctx-menu');
  if (ctxArea && ctxMenu) {
    ctxArea.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      ctxArea.classList.add('ctx-active');
      ctxMenu.classList.add('visible');
    });
    document.addEventListener('click', function() {
      ctxClose();
    });
  }
  window.ctxClose = function() {
    if (ctxMenu) ctxMenu.classList.remove('visible');
    if (ctxArea) ctxArea.classList.remove('ctx-active');
  };

  /* ── S17D: Expandable Rows ── */
  window.expToggle = function(id) {
    var row = document.getElementById(id);
    var detail = document.getElementById(id + '-detail');
    if (!row || !detail) return;
    row.classList.toggle('open');
  };

  /* ── S17E: Multi-Select ── */
  window.mselToggle = function(item) {
    item.classList.toggle('selected');
    updateMselBatch();
  };
  function updateMselBatch() {
    var list = document.getElementById('msel');
    var batch = document.getElementById('msel-batch');
    if (!list || !batch) return;
    var count = list.querySelectorAll('.msel-item.selected').length;
    batch.querySelector('span').textContent = count + ' selected';
    batch.style.display = count > 0 ? 'flex' : 'none';
  }
  updateMselBatch();

  /* ── S17F: Time Range ── */
  window.trSelect = function(el) {
    var pills = document.querySelectorAll('#tr-pills .tr-pill');
    pills.forEach(function(p) { p.classList.remove('active'); });
    el.classList.add('active');
    var custom = document.getElementById('tr-custom');
    if (custom) custom.style.display = el.dataset.val === 'custom' ? 'flex' : 'none';
  };

  /* ── S18A: WebSocket Sparkline ── */
  var wsSparkline = document.getElementById('ws-sparkline');
  if (wsSparkline) {
    var bars = [];
    for (var i = 0; i < 20; i++) {
      var b = document.createElement('div');
      b.className = 'ws-bar';
      var h = Math.floor(Math.random() * 36) + 4;
      b.style.height = h + 'px';
      if (h > 30) b.classList.add('ws-peak');
      wsSparkline.appendChild(b);
      bars.push(b);
    }
    setInterval(function() {
      bars.shift().remove();
      var nb = document.createElement('div');
      nb.className = 'ws-bar';
      var nh = Math.floor(Math.random() * 36) + 4;
      nb.style.height = nh + 'px';
      if (nh > 30) nb.classList.add('ws-peak');
      wsSparkline.appendChild(nb);
      bars.push(nb);
    }, 400);
  }

  /* ── S18A: WS state buttons ── */
  window.wsSetState = function(btn, state) {
    var btns = document.querySelectorAll('.ws-state-btn');
    btns.forEach(function(b) {
      b.classList.remove('ws-connected','ws-paused','ws-disconnected');
    });
    btn.classList.add('ws-' + state);
  };

  /* ── S18B: Virtual Scroll Minimap ── */
  var vLog = document.getElementById('vscroll-log');
  var vTrack = document.getElementById('vscroll-track');
  var vThumb = document.getElementById('vscroll-thumb');
  if (vLog && vTrack) {
    var lines = [
      {txt:'[14:32:01] INFO  DagScheduler: ExecutionPlan built in 12ms',cls:''},
      {txt:'[14:32:01] WARN  SparkClient: PartitionSkew ratio=4.7',cls:'vscroll-log-warn'},
      {txt:'[14:32:02] INFO  Ingesting Orders_Delta row_count=12,441',cls:''},
      {txt:'[14:32:03] ERROR DAGExecutor: NullReferenceException at node-7',cls:'vscroll-log-err'},
      {txt:'[14:32:03] INFO  RetryPolicy: Attempt 2 of 3',cls:''},
      {txt:'[14:32:04] INFO  DAGExecutor: node-7 recovered',cls:''},
      {txt:'[14:32:05] WARN  Memory: Heap usage at 78%',cls:'vscroll-log-warn'},
      {txt:'[14:32:06] INFO  Checkpoint written at offset=98,412',cls:''},
    ];
    lines.forEach(function(l) {
      var d = document.createElement('div');
      d.className = 'vscroll-log-line ' + l.cls;
      d.textContent = l.txt;
      vLog.appendChild(d);
    });
    var mapH = 120;
    lines.forEach(function(l, i) {
      var dot = document.createElement('div');
      dot.className = 'vscroll-dot' + (l.cls.indexOf('err') > -1 ? ' vscroll-err' : l.cls.indexOf('warn') > -1 ? ' vscroll-warn' : '');
      dot.style.top = Math.floor((i / lines.length) * (mapH - 4)) + 'px';
      vTrack.appendChild(dot);
    });
  }

  /* ── S18D: Lock Card ── */
  window.lockToggle = function() {
    var card = document.getElementById('lock-card');
    if (!card) return;
    if (card.classList.contains('locked')) {
      card.classList.remove('locked');
      card.classList.add('unlocked');
      card.querySelector('.lock-ico').style.color = 'var(--green)';
      card.querySelector('.lock-title').textContent = 'Production Table';
      card.querySelector('.lock-desc').textContent = 'Unlocked · available for writes';
      card.querySelector('.lock-hint').textContent = 'Click to lock';
    } else {
      card.classList.remove('unlocked');
      card.classList.add('locked');
      card.querySelector('.lock-ico').style.color = 'var(--amber)';
      card.querySelector('.lock-title').textContent = 'Production Table';
      card.querySelector('.lock-desc').textContent = 'Locked by sana@microsoft.com · just now';
      card.querySelector('.lock-hint').textContent = 'Click to unlock';
    }
  };

  /* ── S18E: Gauge ── */
  var GAUGE_CIRC = 188.5;
  window.gaugeUpdate = function(val) {
    var pct = parseInt(val, 10);
    var path = document.getElementById('gauge-path');
    var lbl = document.getElementById('gauge-pct');
    if (!path || !lbl) return;
    var offset = GAUGE_CIRC - (GAUGE_CIRC * pct / 100);
    path.style.strokeDashoffset = offset;
    lbl.textContent = pct + '%';
    var color = pct > 80 ? '#e5453b' : pct > 60 ? '#e5940c' : '#6d5cff';
    path.style.stroke = color;
  };

  /* ── S18F: Animated Counters ── */
  var animTargets = [1247803, 3, 142];
  var animCurrent = [0, 0, 0];
  var animEl = [
    document.getElementById('an-0'),
    document.getElementById('an-1'),
    document.getElementById('an-2')
  ];
  function animStep() {
    var allDone = true;
    animCurrent.forEach(function(cur, i) {
      var el = animEl[i];
      if (!el) return;
      var target = animTargets[i];
      if (cur < target) {
        allDone = false;
        var step = Math.max(1, Math.ceil((target - cur) / 18));
        animCurrent[i] = Math.min(cur + step, target);
        el.textContent = animCurrent[i].toLocaleString();
        el.className = 'anim-num-val up';
      }
    });
    if (!allDone) requestAnimationFrame(animStep);
  }
  if (animEl[0]) {
    var obs = new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting) {
        animStep();
        obs.disconnect();
      }
    });
    obs.observe(animEl[0]);
  }

  /* ── S19A: Resizable Panel ── */
  var rWrap = document.getElementById('resize-wrap');
  var rLeft = document.getElementById('r-left');
  var rDiv  = document.getElementById('r-div');
  if (rWrap && rLeft && rDiv) {
    var dragging = false;
    var startX = 0;
    var startW = 0;
    rDiv.addEventListener('mousedown', function(e) {
      dragging = true;
      startX = e.clientX;
      startW = rLeft.offsetWidth;
      rDiv.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var newW = Math.max(80, Math.min(startW + dx, rWrap.offsetWidth - 88));
      rLeft.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (!dragging) return;
      dragging = false;
      rDiv.classList.remove('dragging');
    });
  }

  /* ── S20A: Error Code Popover ── */
  window.errPopToggle = function() {
    var pop = document.getElementById('err-popover');
    if (pop) pop.classList.toggle('visible');
  };

  /* ── S20F: Session History ── */
  window.sessToggle = function() {
    var entry = document.getElementById('sess-entry');
    if (entry) entry.classList.toggle('open');
  };

})();
</script>
"""

# ─────────────────────────────────────────────
# 4. Do the replacements
# ─────────────────────────────────────────────
content = FILE.read_text(encoding='utf-8')

# Anchor: unique string at end of section 16, before </main>
ANCHOR_MAIN = "        <div class=\"kbd-row\"><span class=\"kbd-act\">Toggle dark mode</span><div class=\"kbd-keys\"><kbd>Ctrl</kbd><span class=\"kbd-plus\">+</span><kbd>Shift</kbd><span class=\"kbd-plus\">+</span><kbd>T</kbd></div></div>\n      </div>\n    </div>\n  </div>\n</section>\n\n</main>\n</div>"

if ANCHOR_MAIN not in content:
    print("ERROR: main anchor not found in file!")
    sys.exit(1)

# Replace: keep section 16 closing, add style + new sections, then </main></div>
new_main = (
    "        <div class=\"kbd-row\"><span class=\"kbd-act\">Toggle dark mode</span>"
    "<div class=\"kbd-keys\"><kbd>Ctrl</kbd><span class=\"kbd-plus\">+</span>"
    "<kbd>Shift</kbd><span class=\"kbd-plus\">+</span><kbd>T</kbd></div></div>\n"
    "      </div>\n    </div>\n  </div>\n</section>\n"
    + NEW_CSS
    + NEW_HTML
    + "\n</main>\n</div>"
)

content = content.replace(ANCHOR_MAIN, new_main, 1)

# Anchor for JS: insert before </body>
ANCHOR_BODY = "</body>\n</html>"
if ANCHOR_BODY not in content:
    print("ERROR: body anchor not found!")
    sys.exit(1)

content = content.replace(ANCHOR_BODY, NEW_JS + "\n</body>\n</html>", 1)

FILE.write_text(content, encoding='utf-8')
print(f"Done. File is now {len(content)} chars / {content.count(chr(10))} lines")
