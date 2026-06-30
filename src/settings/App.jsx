import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen, emit } from "../lib/tauri.js";
import TitleBar from "../components/TitleBar.jsx";
import { MdKeyboard, MdPhotoCamera, MdLink, MdChevronRight, MdChevronLeft, MdTune, MdInfo } from "react-icons/md";
import { SiGoogledrive } from "react-icons/si";
import { useT } from "../lib/i18n.js";
import { Toggle, Radio, Row, Card, Button, inputCls } from "../components/settingsUI.jsx";
import { ShortcutCard, PrintscreenCard } from "../components/ShortcutEditor.jsx";
import { DirectLinkCard } from "../components/DirectLinkEditor.jsx";
import LegalDocModal from "../components/LegalDocModal.jsx";
import WhatsNewModal from "../components/WhatsNewModal.jsx";
import { compareVersions } from "../lib/version.js";
import logo from "../assets/logo.png";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "tr", label: "Türkçe" },
];

export default function App() {
  const [settings,          setSettings]          = useState(null);
  const [drive,              setDrive]             = useState({ connected: false, email: null });
  const [transfers,          setTransfers]         = useState({ active: [], queued: [], history: [], queued_count: 0 });
  const [saveError,          setSaveError]         = useState("");
  const [connecting,         setConnecting]        = useState(false);
  const [galleryOpen,        setGalleryOpen]       = useState(false);
  const [customCreds,        setCustomCreds]       = useState(false);
  const [hasBuiltinCreds,    setHasBuiltinCreds]   = useState(true);
  const [driveFolders,       setDriveFolders]      = useState(null);
  const [loadingFolders,     setLoadingFolders]    = useState(false);
  const [page,               setPage]              = useState(null);
  const rerunWizard = async () => {
    if (window.__TAURI__?.event) {
      await window.__TAURI__.event.emit("show-onboarding");
    }
    if (window.__TAURI__?.window) {
      window.__TAURI__.window.getCurrentWindow().close();
    }
  };
  const [isElevated,         setIsElevated]        = useState(false);
  const [isPackagedInstall,  setIsPackagedInstall] = useState(false);
  // Admin/elevation mode only exists on Windows (UAC) — hide that UI elsewhere.
  const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
  // Post-connect folder picker
  const [postConnectFolders, setPostConnectFolders] = useState(null);  // null = not shown, [] = loading, [...] = list
  const [postConnectLoading, setPostConnectLoading] = useState(false);
  const [postConnectManual,  setPostConnectManual]  = useState("");
  const [appVersion,         setAppVersion]         = useState("");
  const [legalDoc,           setLegalDoc]           = useState(null); // "terms" | "privacy" | "license" | null
  const [updateStatus,       setUpdateStatus]       = useState("idle"); // idle | checking | up-to-date | available | downloading | ready | error
  const [updateInfo,         setUpdateInfo]         = useState(null);
  const [updateError,        setUpdateError]        = useState("");
  const [downloadProgress,   setDownloadProgress]   = useState(null); // { downloaded, total }
  const [historyOpen,        setHistoryOpen]        = useState(false);
  const [history,            setHistory]            = useState(null);
  const [historyLoading,     setHistoryLoading]     = useState(false);
  const settingsRef = useRef(null);
  const saveTimer   = useRef(null);

  const lang = settings?.language ?? "en";
  const t    = useT(lang);
  const dateLocale = lang === "tr" ? "tr-TR" : "en-US";

  useEffect(() => { document.title = `Shotcove — ${t("settings.title")}`; }, [lang]);

  const refreshDriveStatus = useCallback(async () => {
    setDrive(await invoke("get_drive_status"));
  }, []);

  const saveNow = useCallback(async (next) => {
    clearTimeout(saveTimer.current);
    try {
      await invoke("save_settings", { settings: next ?? settingsRef.current });
    } catch (e) {
      setSaveError(t("settings.saveError") + e);
    }
  }, [t]);

  const scheduleSave = useCallback((next) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveNow(next), 300);
  }, [saveNow]);

  const apply = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      settingsRef.current = next;
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

useEffect(() => { invoke("window_ready").catch(() => {}); }, []);

  useEffect(() => {
    let unlisten = [];
    (async () => {
      const s = await invoke("get_settings");
      settingsRef.current = s;
      setSettings(s);
      
      const open = await invoke("is_gallery_open");
      setGalleryOpen(open);
      
      unlisten.push(await listen("gallery-opened", () => setGalleryOpen(true)));
      unlisten.push(await listen("gallery-closed", () => setGalleryOpen(false)));
      
      invoke("has_builtin_credentials").then((v) => {
        setHasBuiltinCreds(v);
        setCustomCreds(!v || !!s.google_client_id);
      }).catch(() => { setCustomCreds(!!s.google_client_id); });
      invoke("get_is_elevated").then(setIsElevated).catch(() => {});
      invoke("is_packaged_install").then(setIsPackagedInstall).catch(() => {});
      refreshDriveStatus();
      invoke("get_transfers").then(setTransfers).catch(() => {});
      unlisten.push(await listen("sync-transfers-changed", (event) => setTransfers(event.payload)));
      unlisten.push(await listen("settings-changed", async () => {
        // Something else (e.g. the editor saving a background template)
        // just wrote settings.json directly. Drop any pending debounced
        // save from here — it closed over a now-stale snapshot and would
        // otherwise overwrite the fresh write a moment later.
        clearTimeout(saveTimer.current);
        const fresh = await invoke("get_settings");
        settingsRef.current = fresh;
        setSettings(fresh);
      }));

      // Dev-only hook for store_screenshots.rs; stripped from prod builds.
      if (import.meta.env.DEV) {
        unlisten.push(await listen("store-screenshot-cmd", ({ payload }) => {
          if (payload?.action === "goto-tab") setPage(payload.tab);
          else if (payload?.action === "set-drive-demo") {
            setDrive({ connected: payload.connected, email: payload.email ?? null, name: payload.name ?? null, photo: payload.photo ?? null });
          }
          requestAnimationFrame(() => setTimeout(() => emit("store-screenshot-ready", { id: payload?.id }), 50));
        }));
      }
    })();
    return () => unlisten.forEach((u) => u());
  }, [refreshDriveStatus]);

  useEffect(() => {
    invoke("get_app_version").then(setAppVersion).catch(() => {});
    let unlisten;
    (async () => {
      unlisten = await listen("update-download-progress", (event) => {
        setDownloadProgress(event.payload);
      });
    })();
    return () => unlisten?.();
  }, []);

  const checkForUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateError("");
    try {
      const info = await invoke("check_for_update");
      if (info) {
        setUpdateInfo(info);
        setUpdateStatus("available");
      } else {
        setUpdateInfo(null);
        setUpdateStatus("up-to-date");
      }
    } catch (e) {
      setUpdateError(String(e));
      setUpdateStatus("error");
    }
  };

  const downloadUpdate = async () => {
    setUpdateStatus("downloading");
    setDownloadProgress(null);
    setUpdateError("");
    try {
      await invoke("download_and_install_update");
      setUpdateStatus("ready");
    } catch (e) {
      setUpdateError(String(e));
      setUpdateStatus("error");
    }
  };

  const openReleaseHistory = async () => {
    setHistoryOpen(true);
    if (history === null) {
      setHistoryLoading(true);
      try {
        setHistory(await invoke("get_release_history"));
      } catch {
        setHistory([]);
      } finally {
        setHistoryLoading(false);
      }
    }
  };

  const browse = async () => {
    const picked = await invoke("pick_folder");
    if (picked) apply({ screenshots_dir: picked });
  };

  const connect = async (loginHint) => {
    // Guard: need either builtin creds or both custom fields filled
    const hasCustom = settings.google_client_id?.trim() && settings.google_client_secret?.trim();
    if (!hasBuiltinCreds && !hasCustom) {
      setSaveError(t("settings.advanced.credentialsHintNoBuiltin"));
      return;
    }
    await saveNow();
    setConnecting(true);
    setSaveError("");
    try {
      await invoke("connect_drive", { loginHint });
      // After successful auth, auto-load Drive folders for the picker
      setPostConnectLoading(true);
      setPostConnectFolders([]); // show picker UI immediately (loading state)
      try {
        const folders = await invoke("list_drive_folders");
        setPostConnectFolders(folders);
      } catch {
        setPostConnectFolders([]);
      } finally {
        setPostConnectLoading(false);
      }
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("cancelled")) setSaveError(msg);
    } finally {
      setConnecting(false);
      refreshDriveStatus();
    }
  };

  const cancelConnect = () => { invoke("cancel_drive_connect"); };

  const dismissPostConnect = () => { setPostConnectFolders(null); setPostConnectManual(""); };

  const pickPostConnectFolder = async (name) => {
    if (!name.trim()) return;
    apply({ drive_folder_name: name.trim() });
    dismissPostConnect();
    // Small delay so save completes before sync starts
    setTimeout(() => invoke("sync_now"), 400);
  };

  const disconnect = async () => {
    await invoke("disconnect_drive");
    refreshDriveStatus();
  };

  const reconnect = async () => {
    const hint = drive.email;
    await invoke("disconnect_drive");
    await connect(hint);
  };

  const syncNow = async () => { await invoke("sync_now"); };

  if (!settings) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-950 text-stone-500">
        {t("settings.loading")}
      </div>
    );
  }

  const NAV = [
    { id: "general",  label: t("settings.nav.general.label"), Icon: MdTune, desc: t("settings.nav.general.desc") },
    { id: "shortcuts", label: t("settings.nav.shortcuts.label"), Icon: MdKeyboard,    desc: t("settings.nav.shortcuts.desc") },
    { id: "kayit",     label: t("settings.nav.record.label"),    Icon: MdPhotoCamera,  desc: t("settings.nav.record.desc")    },
    {
      id: "drive", label: t("settings.nav.drive.label"), Icon: SiGoogledrive,
      desc: drive.connected ? (drive.name || drive.email || t("settings.nav.drive.connected")) : t("settings.nav.drive.disconnected"),
    },
    { id: "link",     label: t("settings.nav.link.label"),    Icon: MdLink, desc: t("settings.nav.link.desc")    },
    { id: "hakkinda", label: t("settings.nav.about.label"),   Icon: MdInfo, desc: appVersion ? `Shotcove v${appVersion}` : t("settings.nav.about.desc") },
  ];

  const currentNav = NAV.find(n => n.id === page);

  return (
    <div className="flex h-screen flex-col bg-stone-950">
      <TitleBar
        title={currentNav ? `Shotcove — ${currentNav.label}` : `Shotcove — ${t("settings.title")}`}
        noMaximize
        noMinimize={galleryOpen}
      />

      {/* Animated slide — two panels with translateX */}
      <div className="relative flex-1 overflow-hidden">

        {/* Panel 1: Main menu */}
        <div className="absolute inset-0 overflow-y-auto py-2 transition-transform duration-200 ease-in-out"
          style={{ transform: page ? "translateX(-100%)" : "translateX(0)" }}>
          {NAV.map(({ id, label, Icon, desc }) => (
            <button key={id} onClick={() => setPage(id)}
              className="flex w-full items-center gap-3.5 px-5 py-3 text-left hover:bg-stone-800/50 active:bg-stone-800 transition-colors">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-800 text-stone-300">
                <Icon size={16} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-stone-100">{label}</span>
                <span className="block text-xs text-stone-500 truncate">{desc}</span>
              </span>
              <MdChevronRight size={18} className="shrink-0 text-stone-600" />
            </button>
          ))}

          {/* Re-run setup button at the bottom of the nav menu */}
          <div className="px-4 py-3 border-t border-stone-800/60 mt-1">
            <button onClick={rerunWizard}
              className="flex w-full items-center gap-3 px-3 py-2.5 rounded-xl border border-stone-800 bg-stone-900/60 hover:bg-stone-800/60 transition-colors text-left">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-500/15 text-accent-400 text-base">
                ✦
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-stone-200">{t("settings.rerunSetup")}</span>
                <span className="block text-xs text-stone-500">{t("settings.rerunSetupHint")}</span>
              </span>
            </button>
          </div>
        </div>

        {/* Panel 2: Sub-page */}
        <div className="absolute inset-0 flex flex-col transition-transform duration-200 ease-in-out"
          style={{ transform: page ? "translateX(0)" : "translateX(100%)" }}>
          <button onClick={() => setPage(null)}
            className="flex items-center gap-1 px-4 py-2 text-xs text-stone-400 hover:text-stone-200 transition-colors border-b border-stone-800 shrink-0">
            <MdChevronLeft size={16} /> {t("settings.back")}
          </button>
          <div className="flex-1 overflow-y-auto px-4 pb-6 pt-3">
          <div className="flex flex-col gap-3">

        {page === "shortcuts" && <>
        <Card
          title={t("settings.shortcuts.title")}
          right={<Toggle checked={settings.hotkeys_enabled} onChange={(v) => apply({ hotkeys_enabled: v })} />}
        >
          {(!settings.shortcuts || settings.shortcuts.length === 0) ? (
            <div className="py-4 text-center text-xs text-stone-600">{t("settings.shortcuts.noSlots")}</div>
          ) : (
            <div className="flex flex-col gap-2 py-2">
              {(settings.shortcuts || []).map((slot, idx) => (
                <ShortcutCard
                  key={slot.id}
                  slot={slot}
                  onChange={(updated) => {
                    const next = settings.shortcuts.map((s, i) => i === idx ? updated : s);
                    apply({ shortcuts: next });
                  }}
                  onRemove={() => apply({ shortcuts: settings.shortcuts.filter((_, i) => i !== idx) })}
                  t={t}
                />
              ))}
            </div>
          )}
          <div className="py-2">
            <Button onClick={() => {
              const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
              apply({ shortcuts: [...(settings.shortcuts || []), { id, combo: "", capture: "area", actions: ["open_editor"], show_in_menu: false, label: "" }] });
            }}>
              + {t("settings.shortcuts.addShortcut")}
            </Button>
          </div>
        </Card>
        <PrintscreenCard settings={settings} onChange={apply} t={t} />
        </>}


        {page === "kayit" && <Card title={t("settings.record.title")}>
          <Row label={t("settings.record.format")} hint={t("settings.record.formatHint")}>
            <select value={settings.format} onChange={(e) => apply({ format: e.target.value })}
              className={`${inputCls} cursor-pointer`}>
              <option value="png">PNG</option>
              <option value="jpg">JPG</option>
              <option value="webp">WEBP</option>
              <option value="avif">AVIF</option>
              <option value="bmp">BMP</option>
            </select>
          </Row>
          {settings.format === "jpg" && (
            <Row label={t("settings.record.jpgQuality")} hint={t("settings.record.jpgQualityHint")}>
              <div className="flex items-center gap-3">
                <input type="range" min="10" max="100" value={settings.jpeg_quality ?? 95}
                  onChange={(e) => apply({ jpeg_quality: Number(e.target.value) })}
                  className="w-44 accent-accent-500 cursor-pointer" />
                <span className="text-sm font-medium text-stone-300 w-8 text-right">{settings.jpeg_quality ?? 95}%</span>
              </div>
            </Row>
          )}
          <Row label={t("settings.record.folder")}>
            <input type="text" value={settings.screenshots_dir}
              placeholder={t("settings.record.folderPlaceholder")}
              onChange={(e) => apply({ screenshots_dir: e.target.value })}
              className={`${inputCls} w-44`} />
            <Button onClick={browse}>{t("settings.record.browse")}</Button>
            <Button onClick={() => invoke("open_screenshots_folder")}>{t("settings.record.open")}</Button>
          </Row>
        </Card>}

        {page === "drive" && <Card
          title={t("settings.drive.title")}
          right={
            <span className={`text-xs font-medium ${drive.connected ? "text-emerald-400" : "text-stone-500"}`}>
              {drive.connected ? t("settings.drive.connected_plain") : t("settings.nav.drive.disconnected")}
            </span>
          }
        >
          {drive.connected && (
            <div className="flex items-center gap-3 px-3 py-3 mb-1 border-b border-stone-800/60">
              {drive.photo ? (
                <img src={drive.photo} referrerPolicy="no-referrer"
                  className="w-10 h-10 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-blue-600
                  flex items-center justify-center text-sm font-bold text-white shrink-0">
                  {(drive.name || drive.email || "G")[0].toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-stone-100 truncate">
                  {drive.name || drive.email || t("settings.drive.connected_plain")}
                </p>
                {drive.name && drive.email && (
                  <p className="text-xs text-stone-500 truncate">{drive.email}</p>
                )}
              </div>
            </div>
          )}
          <Row label={t("settings.drive.sync")}>
            <Toggle checked={settings.sync_enabled} onChange={(v) => apply({ sync_enabled: v })} />
          </Row>

          <div className="flex flex-col gap-1.5 py-2 border-b border-stone-800">
            {[
              { value: "full",        ...t("settings.drive.syncModes.full") },
              { value: "local_first", ...t("settings.drive.syncModes.localFirst") },
              { value: "manual",      ...t("settings.drive.syncModes.manual") },
            ].map(({ value, label, desc, recommended }) => (
              <div key={value} onClick={() => apply({ sync_mode: value })}
                className="flex items-start gap-2.5 cursor-pointer px-3 py-1.5 rounded hover:bg-stone-800/50 transition">
                <Radio checked={settings.sync_mode === value}
                  onChange={() => apply({ sync_mode: value })}
                  className="mt-0.5" />
                <span className="flex flex-col">
                  <span className="text-xs text-stone-200 font-medium">
                    {label}
                    {recommended && <span className="ml-1.5 text-sky-500 text-[10px]">{recommended}</span>}
                  </span>
                  <span className="text-[11px] text-stone-500">{desc}</span>
                </span>
              </div>
            ))}
          </div>

          <Row label={t("settings.drive.folderName")}>
            <div className="flex gap-1.5 items-center">
              <input type="text" value={settings.drive_folder_name}
                onChange={(e) => apply({ drive_folder_name: e.target.value || "Shotcove" })}
                className={`${inputCls} w-32`} />
              {drive.connected && (
                <button
                  onClick={async () => {
                    setLoadingFolders(true);
                    try { setDriveFolders(await invoke("list_drive_folders")); }
                    catch { setDriveFolders([]); }
                    finally { setLoadingFolders(false); }
                  }}
                  className="text-xs px-2 py-1 rounded bg-stone-800 hover:bg-stone-700 text-stone-300 transition whitespace-nowrap"
                >
                  {loadingFolders ? "…" : t("settings.drive.browseFolders")}
                </button>
              )}
            </div>
          </Row>

          {driveFolders !== null && (
            <div className="mx-3 mb-2 rounded border border-stone-700 bg-stone-900 overflow-hidden">
              <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-stone-700">
                <span className="text-xs text-stone-400">{t("settings.drive.selectFolder")}</span>
                <button onClick={() => setDriveFolders(null)} className="text-stone-600 hover:text-stone-400 text-xs">✕</button>
              </div>
              {driveFolders.length === 0 ? (
                <p className="text-xs text-stone-500 px-2.5 py-2">{t("settings.drive.noFolders")}</p>
              ) : (
                <div className="max-h-40 overflow-y-auto">
                  {driveFolders.map((f) => (
                    <button key={f.id}
                      onClick={() => { apply({ drive_folder_name: f.name }); setDriveFolders(null); }}
                      className="w-full flex items-center justify-between px-2.5 py-1.5 text-left hover:bg-stone-800 transition">
                      <span className="text-xs text-stone-200 truncate">{f.name}</span>
                      <span className={`text-[10px] shrink-0 ml-2 ${f.is_shotcove ? "text-sky-400" : "text-stone-500"}`}>
                        {f.is_shotcove ? t("settings.drive.shotcoveBackup") : f.empty ? t("settings.drive.folderEmpty") : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="border-t border-stone-700 px-2.5 py-2 flex gap-2">
                <input
                  type="text"
                  placeholder={t("settings.drive.postConnect.manualPlaceholder")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.target.value.trim()) {
                      apply({ drive_folder_name: e.target.value.trim() });
                      setDriveFolders(null);
                    }
                  }}
                  className={`${inputCls} flex-1 text-xs`}
                />
                <button
                  onMouseDown={(e) => {
                    const input = e.currentTarget.previousSibling;
                    if (input.value.trim()) { apply({ drive_folder_name: input.value.trim() }); setDriveFolders(null); }
                  }}
                  className="rounded px-2 py-1 text-xs bg-stone-700 hover:bg-stone-600 text-stone-300 transition whitespace-nowrap"
                >{t("settings.drive.postConnect.manualConfirm")}</button>
              </div>
            </div>
          )}

          {/* Post-connect folder picker */}
          {postConnectFolders !== null && drive.connected && (
            <div className="my-1 rounded-xl border border-sky-500/30 bg-sky-500/5 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-sky-500/20">
                <div>
                  <p className="text-sm font-semibold text-sky-300">{t("settings.drive.postConnect.title")}</p>
                  <p className="text-xs text-stone-400 mt-0.5">{t("settings.drive.postConnect.subtitle")}</p>
                </div>
                <button onClick={dismissPostConnect} className="text-stone-500 hover:text-stone-300 transition text-lg leading-none px-1">✕</button>
              </div>

              {postConnectLoading ? (
                <p className="px-4 py-4 text-xs text-stone-400 animate-pulse">{t("settings.drive.postConnect.loading")}</p>
              ) : (
                <div className="max-h-52 overflow-y-auto divide-y divide-stone-800/60">
                  {/* Existing folders */}
                  {postConnectFolders.map((f) => (
                    <button key={f.id} onClick={() => pickPostConnectFolder(f.name)}
                      className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-sky-500/10 transition group">
                      <span className="text-sm text-stone-200 truncate group-hover:text-sky-200 transition">{f.name}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        {f.is_shotcove && <span className="text-[10px] text-sky-400 bg-sky-400/10 px-1.5 py-0.5 rounded">{t("settings.drive.shotcoveBackup")}</span>}
                        {f.empty     && <span className="text-[10px] text-stone-500">{t("settings.drive.folderEmpty")}</span>}
                        <span className="text-xs text-sky-400 opacity-0 group-hover:opacity-100 transition">{t("settings.drive.postConnect.use")}</span>
                      </span>
                    </button>
                  ))}
                  {/* Default / new folder option */}
                  <button onClick={() => pickPostConnectFolder("Shotcove")}
                    className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-stone-800/50 transition group">
                    <span className="text-sm text-stone-400 group-hover:text-stone-200 transition">
                      {postConnectFolders.length === 0
                        ? t("settings.drive.postConnect.newDefault")
                        : t("settings.drive.postConnect.useDefault")}
                    </span>
                    <span className="text-xs text-stone-500 group-hover:text-stone-300 transition">{t("settings.drive.postConnect.use")}</span>
                  </button>
                </div>
              )}

              {/* Manual folder name input */}
              <div className="border-t border-sky-500/15 px-4 py-3 flex flex-col gap-2">
                <span className="text-[11px] text-stone-500">{t("settings.drive.postConnect.manualHint")}</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={postConnectManual}
                    onChange={(e) => setPostConnectManual(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && postConnectManual.trim()) pickPostConnectFolder(postConnectManual); }}
                    placeholder={t("settings.drive.postConnect.manualPlaceholder")}
                    className={`${inputCls} flex-1 text-sm`}
                  />
                  <button
                    disabled={!postConnectManual.trim()}
                    onClick={() => pickPostConnectFolder(postConnectManual)}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >{t("settings.drive.postConnect.manualConfirm")}</button>
                </div>
              </div>

              <div className="border-t border-sky-500/20 px-4 py-2 flex justify-end">
                <button onClick={dismissPostConnect} className="text-xs text-stone-500 hover:text-stone-300 transition">
                  {t("settings.drive.postConnect.skip")}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 py-3">
            {drive.connected ? (
              <>
                <Button variant="danger" onClick={disconnect}>{t("settings.drive.disconnect")}</Button>
                <Button variant="primary" disabled={connecting} onClick={reconnect}>
                  {connecting ? t("settings.drive.connecting") : t("settings.drive.reconnect")}
                </Button>
              </>
            ) : (
              <Button variant="primary" disabled={connecting} onClick={() => connect(null)}>
                {connecting ? t("settings.drive.connecting") : t("settings.drive.connect")}
              </Button>
            )}
            {connecting && (
              <Button onClick={cancelConnect}>{t("common.cancel")}</Button>
            )}
            <Button onClick={syncNow}>{t("settings.drive.syncNow")}</Button>
            {(transfers.active?.length > 0 || transfers.queued?.length > 0 || transfers.history?.length > 0) && (
              <button
                onClick={() => setTransfers({ active: [], queued: [], history: [], queued_count: 0 })}
                className="ml-auto text-xs text-stone-600 hover:text-stone-400 transition"
              >{t("settings.drive.clear")}</button>
            )}
          </div>

          {/* Transfer history */}
          <div className="mb-3 rounded-lg border border-stone-800 bg-stone-950">
            <div className="flex items-center justify-between border-b border-stone-800 px-3 py-2">
              <span className="text-xs font-medium text-stone-400">{t("settings.drive.transferHistory")}</span>
              {(transfers.active?.length > 0 || transfers.queued?.length > 0 || transfers.history?.length > 0) && (
                <button onClick={() => setTransfers({ active: [], queued: [], history: [], queued_count: 0 })}
                  className="text-xs text-stone-600 hover:text-stone-400 transition">{t("settings.drive.clear")}</button>
              )}
            </div>
            {(!transfers.active?.length && !transfers.queued?.length && !transfers.history?.length) ? (
              <p className="px-3 py-3 text-xs text-stone-600">{t("settings.drive.noTransfers")}</p>
            ) : (
              <div className="max-h-48 overflow-y-auto">
                {[...(transfers.active || []), ...(transfers.queued || []), ...(transfers.history || [])].map((tr, i) => (
                  <div key={i} className="flex items-start gap-2 border-b border-stone-800/60 px-3 py-1.5 last:border-0">
                    <span className={`mt-0.5 shrink-0 text-xs ${
                      tr.status === "done"      ? "text-emerald-400" :
                      tr.status === "error"     ? "text-red-400"     :
                      tr.status === "uploading" ? "text-blue-400"    : "text-stone-500"
                    }`}>
                      {tr.status === "done" ? "✓" : tr.status === "error" ? "✗" : tr.status === "uploading" ? "↑" : "·"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-stone-300">
                        {tr.file}
                        {tr.file === "File Scan" && tr.total > 0 && ` (${tr.sent}/${tr.total})`}
                      </p>
                      {tr.message && (
                        <p className={`truncate text-xs ${tr.status === "error" ? "text-red-400/80" : "text-stone-500"}`}>{tr.message}</p>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-stone-600">
                      {new Date(tr.time).toLocaleTimeString(dateLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {saveError && <p className="pb-2 text-xs text-red-400">{saveError}</p>}
          <p className="pb-3 text-xs leading-relaxed text-stone-500">
            {t("settings.drive.driveNote_pre")}
            <code className="rounded bg-stone-800 px-1 py-0.5 text-stone-300">drive.file</code>
            {t("settings.drive.driveNote_post")}
          </p>
        </Card>}

        {page === "drive" && <Card title={t("settings.advanced.credentialsTitle")}>
          <div className="py-3 text-xs text-stone-500 leading-relaxed">
            {hasBuiltinCreds ? t("settings.advanced.credentialsHint") : t("settings.advanced.credentialsHintNoBuiltin")}
          </div>
          {hasBuiltinCreds && (
            <Row label={t("settings.advanced.mode")}>
              <select
                value={customCreds ? "custom" : "builtin"}
                onChange={(e) => {
                  if (e.target.value === "builtin") {
                    setCustomCreds(false);
                    apply({ google_client_id: "", google_client_secret: "" });
                  } else {
                    setCustomCreds(true);
                  }
                }}
                className={`${inputCls} w-44`}
              >
                <option value="builtin">{t("settings.advanced.modeBuiltin")}</option>
                <option value="custom">{t("settings.advanced.modeCustom")}</option>
              </select>
            </Row>
          )}
          {customCreds && (
            <>
              <Row label={t("settings.advanced.clientId")}>
                <input type="text" value={settings.google_client_id}
                  placeholder="xxxx.apps.googleusercontent.com"
                  onChange={(e) => apply({ google_client_id: e.target.value.trim() })}
                  className={`${inputCls} w-52`} />
              </Row>
              <Row label={t("settings.advanced.clientSecret")}>
                <input type="password" value={settings.google_client_secret}
                  placeholder={t("settings.advanced.clientSecretPlaceholder")}
                  onChange={(e) => apply({ google_client_secret: e.target.value.trim() })}
                  className={`${inputCls} w-52`} />
              </Row>
            </>
          )}
        </Card>}

        {page === "link" && <DirectLinkCard settings={settings} apply={apply} t={t} />}

        {page === "general" && (
          <>
            <Card title={t("settings.language.title")}>
              <div className="flex flex-col gap-0.5 py-1">
                {LANGUAGES.map(({ code, label }) => (
                  <div key={code} onClick={() => apply({ language: code })}
                    className="flex cursor-pointer items-center justify-between px-4 py-2.5 hover:bg-stone-800/50 rounded-lg transition-colors">
                    <span className="text-sm text-stone-200">{label}</span>
                    <Radio checked={(settings.language ?? "en") === code}
                      onChange={() => apply({ language: code })} />
                  </div>
                ))}
              </div>
            </Card>
            <Card title={t("settings.startup.title")}>
              <Row label={t("settings.record.startWithWindows")}>
                <Toggle checked={settings.autostart} onChange={(v) => apply({ autostart: v })} />
              </Row>
              <Row label={t("settings.record.openGalleryOnStart")}>
                <Toggle checked={settings.start_with_gallery} onChange={(v) => apply({ start_with_gallery: v })} />
              </Row>
              {isWindows && (
                <Row
                  label={t("settings.admin.runAsAdmin")}
                  hint={t("settings.admin.runAsAdminHint")}
                >
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${isElevated ? "bg-emerald-500/20 text-emerald-400" : "bg-stone-800 text-stone-500"}`}>
                    {isElevated ? t("settings.admin.running") : t("settings.admin.standard")}
                  </span>
                  <Toggle checked={settings.run_as_admin ?? false} onChange={(v) => apply({ run_as_admin: v })} />
                </Row>
              )}
              {isWindows && (settings.run_as_admin ?? false) && !isElevated && (
                <Row label={t("settings.admin.restartHint")}>
                  <Button variant="primary" onClick={() => invoke("request_admin")}>
                    {t("settings.admin.restartAsAdmin")}
                  </Button>
                </Row>
              )}
              {isWindows && (settings.run_as_admin ?? false) && (settings.autostart ?? false) && isElevated && (
                <div className="pb-3 text-xs text-amber-400/80">{t("settings.admin.autostartNote")}</div>
              )}
            </Card>
          </>
        )}

        {page === "hakkinda" && (
          <div className="flex flex-col items-center gap-5 pt-6 pb-6 text-center">
            <img src={logo} alt="" className="h-20 w-20" />
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold text-stone-100">Shotcove</h2>
              <p className="text-sm text-stone-500">
                {appVersion ? `${t("settings.about.versionPrefix")} ${appVersion}` : t("settings.about.version")}
              </p>
            </div>
            <p className="max-w-xs text-sm text-stone-400 leading-relaxed">{t("settings.about.description")}</p>

            {/* Updates */}
            <div className="w-full rounded-xl border border-stone-800 bg-stone-900 overflow-hidden text-left">
              {isPackagedInstall ? (
                <div className="px-4 py-2.5 text-[11px] text-stone-500">
                  {t("settings.about.updateManagedByStore")}
                </div>
              ) : (
              <>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-800">
                <div>
                  <p className="text-xs text-stone-300">{t("settings.about.autoUpdate")}</p>
                  <p className="text-[11px] text-stone-600">{t("settings.about.autoUpdateHint")}</p>
                </div>
                <Toggle checked={settings.auto_update ?? true} onChange={(v) => apply({ auto_update: v })} />
              </div>

              <div className="px-4 py-3">
                {updateStatus === "idle" && (
                  <button
                    onClick={checkForUpdate}
                    className="w-full rounded-lg border border-stone-700 bg-stone-800/60 px-3 py-2 text-xs text-stone-300 hover:bg-stone-700/60 hover:text-stone-100 transition-colors"
                  >
                    {t("settings.about.checkForUpdates")}
                  </button>
                )}
                {updateStatus === "checking" && (
                  <p className="text-xs text-stone-500">{t("settings.about.checking")}</p>
                )}
                {updateStatus === "up-to-date" && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-emerald-400">{t("settings.about.upToDate")}</p>
                    <button
                      onClick={checkForUpdate}
                      className="w-full rounded-lg border border-stone-700 bg-stone-800/60 px-3 py-2 text-xs text-stone-300 hover:bg-stone-700/60 hover:text-stone-100 transition-colors"
                    >
                      {t("settings.about.checkForUpdates")}
                    </button>
                  </div>
                )}
                {updateStatus === "error" && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-red-400">{t("settings.about.updateError")}: {updateError}</p>
                    <button
                      onClick={checkForUpdate}
                      className="w-full rounded-lg border border-stone-700 bg-stone-800/60 px-3 py-2 text-xs text-stone-300 hover:bg-stone-700/60 hover:text-stone-100 transition-colors"
                    >
                      {t("settings.about.checkForUpdates")}
                    </button>
                  </div>
                )}
                {updateStatus === "available" && updateInfo && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-amber-400">
                      {t("settings.about.versionAvailable").replace("{version}", updateInfo.version)}
                    </p>
                    {updateInfo.body && (
                      <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] text-stone-500">
                        {updateInfo.body}
                      </p>
                    )}
                    <button
                      onClick={downloadUpdate}
                      className="w-full rounded-lg border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-xs text-amber-400 hover:bg-amber-800/30 hover:text-amber-300 transition-colors"
                    >
                      {t("settings.about.downloadUpdate")}
                    </button>
                  </div>
                )}
                {updateStatus === "downloading" && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-stone-500">{t("settings.about.downloading")}</p>
                    {downloadProgress?.total ? (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-800">
                        <div
                          className="h-full bg-amber-500 transition-all"
                          style={{ width: `${Math.min(100, (downloadProgress.downloaded / downloadProgress.total) * 100)}%` }}
                        />
                      </div>
                    ) : null}
                  </div>
                )}
                {updateStatus === "ready" && (
                  <p className="text-xs text-emerald-400">{t("settings.about.restartNow")}</p>
                )}
              </div>
              </>
              )}

              <button
                onClick={openReleaseHistory}
                disabled={historyLoading}
                className="flex w-full items-center justify-between border-t border-stone-800 px-4 py-2.5 text-xs text-stone-400 hover:bg-stone-800/50 hover:text-stone-200 transition-colors disabled:opacity-50"
              >
                {historyLoading ? t("settings.about.loadingHistory") : t("settings.about.releaseHistory")}
                <MdChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            {historyOpen && history !== null && (
              <WhatsNewModal
                releases={[...history]
                  .filter((r) => !appVersion || compareVersions(r.version, appVersion) <= 0)
                  .sort((a, b) => compareVersions(b.version, a.version))}
                lang={lang}
                t={t}
                onClose={() => setHistoryOpen(false)}
              />
            )}

            {/* Info rows */}
            <div className="w-full rounded-xl border border-stone-800 bg-stone-900 overflow-hidden text-left">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-800">
                <span className="text-xs text-stone-500">{t("settings.about.developer")}</span>
                <span className="text-xs text-stone-300">Alperen Çetin (xacnio)</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-800">
                <span className="text-xs text-stone-500">{t("settings.about.platform")}</span>
                <span className="text-xs text-stone-300">{t("settings.about.platformValue")}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs text-stone-500">{t("settings.about.license")}</span>
                <button onClick={() => setLegalDoc("license")}
                  className="text-xs text-stone-300 underline hover:text-stone-100 transition-colors">
                  {t("settings.about.licenseValue")}
                </button>
              </div>
            </div>

            {/* Legal links */}
            <div className="flex gap-2 w-full">
              <button
                onClick={() => setLegalDoc("terms")}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-stone-700 bg-stone-800/60 px-3 py-2 text-xs text-stone-300 hover:bg-stone-700/60 hover:text-stone-100 transition-colors"
              >
                {t("settings.about.terms")}
              </button>
              <button
                onClick={() => setLegalDoc("privacy")}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-stone-700 bg-stone-800/60 px-3 py-2 text-xs text-stone-300 hover:bg-stone-700/60 hover:text-stone-100 transition-colors"
              >
                {t("settings.about.privacy")}
              </button>
            </div>

            {/* External links */}
            <div className="flex flex-col gap-2 w-full">
              <div className="flex gap-2">
                <button
                  onClick={() => invoke("open_url", { url: "https://github.com/xacnio" })}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-stone-700 bg-stone-800/60 px-3 py-2 text-xs text-stone-300 hover:bg-stone-700/60 hover:text-stone-100 transition-colors"
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current shrink-0" aria-hidden="true">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                      0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
                      -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
                      .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
                      -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
                      .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
                      .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
                      0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                  </svg>
                  {t("settings.about.github")}
                </button>
                <button
                  onClick={() => invoke("open_url", { url: "https://buymeacoffee.com/xacnio" })}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-400 hover:bg-yellow-800/30 hover:text-yellow-300 transition-colors"
                >
                  <span className="text-sm leading-none">☕</span>
                  {t("settings.about.supportDev")}
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => invoke("open_url", { url: "https://github.com/xacnio/shotcove" })}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-stone-700 bg-stone-800/60 px-3 py-2 text-xs text-stone-300 hover:bg-stone-700/60 hover:text-stone-100 transition-colors"
                >
                  <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current shrink-0" aria-hidden="true">
                    <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/>
                  </svg>
                  {t("settings.about.repo")}
                </button>
                <button
                  onClick={() => invoke("open_url", { url: "https://github.com/xacnio/shotcove/issues" })}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-stone-700 bg-stone-800/60 px-3 py-2 text-xs text-stone-300 hover:bg-stone-700/60 hover:text-stone-100 transition-colors"
                >
                  <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current shrink-0" aria-hidden="true">
                    <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/><path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/>
                  </svg>
                  {t("settings.about.issues")}
                </button>
              </div>
            </div>

            {/* Open source credits */}
            <div className="w-full text-left">
              <p className="mb-2 text-xs font-medium text-stone-400 uppercase tracking-wider px-0.5">{t("settings.about.creditsTitle")}</p>
              <p className="mb-3 text-xs text-stone-600">{t("settings.about.creditsDesc")}</p>
              <div className="rounded-xl border border-stone-800 bg-stone-900 overflow-hidden divide-y divide-stone-800/70">
                {[
                  { name: "Tauri",         license: "MIT / Apache-2.0", url: "https://tauri.app" },
                  { name: "React",         license: "MIT",              url: "https://react.dev" },
                  { name: "Tailwind CSS",  license: "MIT",              url: "https://tailwindcss.com" },
                  { name: "Vite",          license: "MIT",              url: "https://vitejs.dev" },
                  { name: "Tokio",         license: "MIT",              url: "https://tokio.rs" },
                  { name: "reqwest",       license: "MIT / Apache-2.0", url: "https://github.com/seanmonstar/reqwest" },
                  { name: "xcap",          license: "MIT",              url: "https://github.com/nashaofu/xcap" },
                  { name: "image-rs",      license: "MIT / Apache-2.0", url: "https://github.com/image-rs/image" },
                  { name: "serde",         license: "MIT / Apache-2.0", url: "https://serde.rs" },
                  { name: "notify",        license: "MIT / Apache-2.0", url: "https://github.com/notify-rs/notify" },
                  { name: "react-icons",   license: "MIT",              url: "https://react-icons.github.io/react-icons" },
                  { name: "TanStack Virtual", license: "MIT",           url: "https://tanstack.com/virtual" },
                  { name: "Manrope",       license: "OFL-1.1",          url: "https://manropefont.com" },
                  { name: "keyring-rs",    license: "MIT",              url: "https://github.com/open-source-cooperative/keyring-rs" },
                ].map(({ name, license, url }) => (
                  <button
                    key={name}
                    onClick={() => invoke("open_url", { url })}
                    className="flex w-full items-center justify-between px-4 py-2 hover:bg-stone-800/50 transition-colors group"
                  >
                    <span className="text-xs text-stone-300 group-hover:text-stone-100 transition-colors">{name}</span>
                    <span className="text-[10px] text-stone-600 group-hover:text-stone-500 transition-colors font-mono">{license}</span>
                  </button>
                ))}
              </div>
            </div>

          </div>
        )}

          </div>
          </div>
        </div>

      </div>

      {legalDoc && (
        <LegalDocModal doc={legalDoc} title={t(`settings.about.${legalDoc}`)} lang={lang} t={t} onClose={() => setLegalDoc(null)} />
      )}
    </div>
  );
}
