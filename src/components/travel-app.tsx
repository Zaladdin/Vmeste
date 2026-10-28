"use client";
import { useEffect, useRef, useState } from "react";
import {
  Luggage,
  FileText,
  Plus,
  Laptop,
  ChevronRight,
  Users,
  Ellipsis,
  Download,
  Upload,
  Trash2,
  Check,
  Menu,
  X,
  BedDouble,
  Plane,
  CircleHelp,
  Compass,
} from "lucide-react";
import {
  daysOfTrip,
  exportTrip,
  importTrip,
  formatDate,
  sampleTrip,
  MAX_PLAN_BYTES,
  type Trip,
  type TripEvent,
  type StoredDocument,
} from "@/lib/model";
import { useAccountStorage } from "./account-storage";
import { TripEditor, EventEditor, MembersEditor } from "./editors";
import { Dialog } from "./dialog";
import { Timeline, Places } from "./timeline";
import { Documents } from "./documents";
import { Tickets, Accommodation, People } from "./trip-sections";
import { publicPath } from "@/lib/deployment";
import { createBackup, restoreBackup } from "@/lib/backup";
import { AppAccess } from "./app-access";
import { CloudAccount, useCloudAccount } from "./cloud-account";
import { RoomsHub } from "./rooms";

type Tab = "plan" | "tickets" | "stays" | "people" | "documents" | "places";
type Editor =
  | { type: "trip"; item?: Trip }
  | { type: "event"; item?: TripEvent; kind?: TripEvent["kind"] }
  | { type: "members" }
  | { type: "delete" }
  | { type: "about" }
  | null;
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Не удалось сохранить данные. Проверьте доступность хранилища браузера.";

export function TravelApp() {
  return (
    <AppAccess>
      <TravelWorkspace />
    </AppAccess>
  );
}

function TravelWorkspace() {
  const account = useCloudAccount();
  const storage = useAccountStorage();
  const {
    initializeTrips,
    loadTrips,
    saveTrip,
    removeTrip,
    listDocuments,
    removeEvent,
  } = storage;
  const [trips, setTrips] = useState<Trip[]>([]);
  const [activeId, setActiveId] = useState("");
  const [tab, setTab] = useState<Tab>("plan");
  const [date, setDate] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [docEvent, setDocEvent] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const mutation = useRef(false);
  const activeIdRef = useRef("");
  const recognitionCount = useRef(0);
  function activate(id: string) {
    activeIdRef.current = id;
    setActiveId(id);
  }
  const trip = trips.find((t) => t.id === activeId);

  useEffect(() => {
    let cancelled = false;
    initializeTrips()
      .then((items) => {
        if (cancelled) return;
        setTrips(items);
        activate(items[0]?.id ?? "");
        setDate(items[0]?.startDate ?? "");
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setDocuments([]);
    if (activeId)
      listDocuments(activeId)
        .then((items) => {
          if (!cancelled) setDocuments(items);
        })
        .catch((e) => {
          if (!cancelled) setError(errorText(e));
        });
    return () => {
      cancelled = true;
    };
  }, [activeId]);
  useEffect(() => {
    if (!menuOpen) return;
    const sidebar = document.getElementById("sidebar");
    document.getElementById("sidebar-close")?.focus();
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab" || !sidebar) return;
      const controls = [
        ...sidebar.querySelectorAll<HTMLElement>(
          "a[href], button:not(:disabled)",
        ),
      ].filter(
        (element) =>
          element.getClientRects().length &&
          getComputedStyle(element).visibility !== "hidden",
      );
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("keydown", keyboard);
      document.getElementById("menu-trigger")?.focus();
    };
  }, [menuOpen]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      !("serviceWorker" in navigator)
    )
      return;
    let cancelled = false;
    // Offline is advertised only after the worker confirms the app shell was cached.
    const message = (event: MessageEvent) => {
      if (!cancelled && event.data?.type === "OFFLINE_READY")
        setOfflineReady(true);
    };
    navigator.serviceWorker.addEventListener("message", message);
    navigator.serviceWorker
      .register(publicPath("/sw.js"), { scope: publicPath("/") })
      .then(async (registration) => {
        const worker =
          registration.installing ??
          registration.waiting ??
          registration.active;
        if (!worker) return;
        if (worker.state !== "activated") {
          await new Promise<void>((resolve, reject) => {
            const changed = () => {
              if (
                worker.state === "activated" ||
                worker.state === "redundant"
              ) {
                worker.removeEventListener("statechange", changed);
                if (worker.state === "activated") resolve();
                else reject(new Error("Service worker did not activate"));
              }
            };
            worker.addEventListener("statechange", changed);
            changed();
          });
        }
        if (cancelled) return;
        const urls = performance
          .getEntriesByType("resource")
          .map((r) => r.name)
          .filter((url) =>
            url.startsWith(location.origin + publicPath("/_next/static/")),
          );
        worker.postMessage({ type: "CACHE_SHELL", urls });
      })
      .catch(() => {
        /* Local plan remains available; no offline-ready claim on failure. */
      });
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", message);
    };
  }, []);
  async function commit(next: Trip) {
    if (recognitionCount.current > 0)
      throw new Error(
        "Дождитесь завершения распознавания документов, затем сохраните изменения.",
      );
    if (mutation.current)
      throw new Error("Дождитесь сохранения предыдущего изменения");
    mutation.current = true;
    setBusy(true);
    try {
      await saveTrip(next);
      setTrips((current) =>
        current.some((t) => t.id === next.id)
          ? current.map((t) => (t.id === next.id ? next : t))
          : [...current, next],
      );
      setToast("Изменения сохранены на этом устройстве");
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  function selectTrip(next: Trip) {
    activate(next.id);
    setDate(next.startDate);
    setTab("plan");
    setDocEvent(undefined);
    setMenuOpen(false);
    setError("");
  }
  async function refreshDocuments() {
    if (trip) {
      const items = await listDocuments(trip.id);
      if (activeIdRef.current === trip.id) setDocuments(items);
    }
  }
  function recognitionProcessing(processing: boolean) {
    recognitionCount.current = Math.max(
      0,
      recognitionCount.current + (processing ? 1 : -1),
    );
  }
  function recognitionImported(updated: Trip) {
    setTrips((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
  }
  async function saveEvent(item: TripEvent) {
    if (!trip) return;
    await commit({
      ...trip,
      events: [...trip.events.filter((e) => e.id !== item.id), item],
    });
    setDate(item.date);
  }
  async function deleteEvent(id: string) {
    if (!trip) return;
    const updated = await removeEvent(trip, id);
    setTrips((current) =>
      current.map((t) => (t.id === updated.id ? updated : t)),
    );
    await refreshDocuments();
    setToast("Событие удалено, документы остались в поездке");
  }
  function download() {
    if (!trip) return;
    try {
      const url = URL.createObjectURL(
        new Blob([exportTrip(trip)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `vmeste-${trip.startDate}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast("План экспортирован. Прикреплённые файлы в экспорт не входят.");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function uploadPlan(file?: File) {
    if (!file) return;
    try {
      if (file.size > MAX_PLAN_BYTES)
        throw new Error("Файл плана должен быть не больше 16 МБ");
      const next = importTrip(await file.text());
      await commit(next);
      selectTrip(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  }
  async function downloadBackup() {
    if (!trip || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    try {
      const blob = await createBackup(trip.id, storage);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vmeste-backup-${trip.startDate}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast("Резервная копия с оригиналами документов сохранена.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function uploadBackup(file?: File) {
    if (!file || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    try {
      const restored = await restoreBackup(file, storage);
      setTrips((current) => [...current, restored]);
      selectTrip(restored);
      setToast("Поездка и документы восстановлены отдельной копией.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      mutation.current = false;
      setBusy(false);
      if (backupInput.current) backupInput.current.value = "";
    }
  }
  async function deleteTrip() {
    if (!trip) return;
    setBusy(true);
    try {
      await removeTrip(trip.id);
      const rest = trips.filter((t) => t.id !== trip.id);
      setTrips((current) => current.filter((item) => item.id !== trip.id));
      if (activeIdRef.current === trip.id) {
        activate(rest[0]?.id ?? "");
        setDate(rest[0]?.startDate ?? "");
      }
      setEditor(null);
      setToast("Поездка и её документы удалены с устройства");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function showDocuments(eventId?: string) {
    setDocEvent(eventId);
    setTab("documents");
    setMenuOpen(false);
  }
  const days = trip ? daysOfTrip(trip.startDate, trip.endDate) : [];
  const selectedDate = days.includes(date) ? date : (trip?.startDate ?? "");

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        К плану поездки
      </a>
      <aside id="sidebar" className={`sidebar ${menuOpen ? "is-open" : ""}`}>
        <a
          href={publicPath("/")}
          className="brand"
          aria-label="Вместе — главная"
        >
          <Compass className="brand-compass" size={30} aria-hidden="true" />
          вместе
        </a>
        <button
          id="sidebar-close"
          className="mobile-menu-close icon-button"
          onClick={() => setMenuOpen(false)}
          aria-label="Закрыть меню"
        >
          <X size={20} />
        </button>
        <nav className="primary-nav" aria-label="Главная навигация">
          {[
            { id: "plan", label: "Мои поездки", Icon: Luggage },
            { id: "tickets", label: "Билеты", Icon: Plane },
            { id: "stays", label: "Проживание", Icon: BedDouble },
            { id: "people", label: "Люди", Icon: Users },
            { id: "documents", label: "Документы", Icon: FileText },
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              className={tab === id ? "nav-item selected" : "nav-item"}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                if (id === "documents") showDocuments();
                else setTab(id as Tab);
                setMenuOpen(false);
              }}
            >
              <Icon size={21} />
              {label}
            </button>
          ))}
        </nav>
        <div className="trip-list-heading">
          <span>Ваши поездки</span>
          <button
            className="icon-button"
            onClick={() => setEditor({ type: "trip" })}
            aria-label="Создать поездку"
            disabled={loading}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="trip-list">
          {trips.map((t) => (
            <button
              className={`trip-pick ${t.id === activeId ? "active" : ""}`}
              key={t.id}
              onClick={() => selectTrip(t)}
            >
              <span className="trip-pick-dot" />
              <span>
                <strong>{t.destination}</strong>
                <small>
                  {formatDate(t.startDate, { day: "numeric", month: "short" })}{" "}
                  — {formatDate(t.endDate, { day: "numeric", month: "short" })}
                </small>
              </span>
            </button>
          ))}
        </div>
        <button
          className="new-trip-button"
          onClick={() => setEditor({ type: "trip" })}
          disabled={loading}
        >
          <Plus size={17} />
          Новая поездка
        </button>
        <div className="sidebar-bottom">
          <div>
            <Laptop size={20} />
            <span>
              На этом устройстве
              <i />
            </span>
          </div>
          <p>
            {offlineReady
              ? "План доступен без интернета"
              : "Данные хранятся в браузере"}
          </p>
          <button
            className="text-button"
            onClick={() => setEditor({ type: "about" })}
          >
            <CircleHelp size={14} />
            Как это работает
          </button>
        </div>
      </aside>
      {menuOpen ? (
        <button
          className="mobile-scrim"
          aria-label="Закрыть меню"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}
      <main id="main-content" className="main" inert={menuOpen}>
        <div className="mobile-topbar">
          <button
            className="icon-button"
            id="menu-trigger"
            aria-label="Открыть меню"
            aria-expanded={menuOpen}
            aria-controls="sidebar"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={22} />
          </button>
          <span className="brand">
            <Compass className="brand-compass" size={26} aria-hidden="true" />
            вместе
          </span>
          <button
            className="icon-button"
            aria-label="Новая поездка"
            onClick={() => setEditor({ type: "trip" })}
          >
            <Plus size={22} />
          </button>
        </div>
        <CloudAccount account={account} disabled={busy} compact />
        {account.session ? (
          <RoomsHub
            key={account.session.user.id}
            userId={account.session.user.id}
            trip={trip}
            open={roomsOpen}
            onToggle={setRoomsOpen}
          />
        ) : null}
        <div className="breadcrumb">
          <span>Мои поездки</span>
          <ChevronRight size={14} />
          <span>{trip?.destination ?? "Путешествия начинаются здесь"}</span>
          {trip ? (
            <details className="trip-actions" key={trip.id}>
              <summary aria-label="Действия с поездкой">
                <Ellipsis size={21} />
              </summary>
              <div
                className="actions-menu"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("button")) {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                  }
                }}
              >
                <button onClick={() => setEditor({ type: "trip", item: trip })}>
                  <Luggage size={16} />
                  Настройки поездки
                </button>
                <button onClick={download}>
                  <Download size={16} />
                  Экспорт плана без файлов
                </button>
                <button onClick={() => importInput.current?.click()}>
                  <Upload size={16} />
                  Импорт плана JSON
                </button>
                <button disabled={busy} onClick={() => void downloadBackup()}>
                  <Download size={16} /> Резервная копия с документами
                </button>
                <button
                  disabled={busy}
                  onClick={() => backupInput.current?.click()}
                >
                  <Upload size={16} /> Восстановить копию с документами
                </button>
                <button
                  className="danger-text"
                  onClick={() => setEditor({ type: "delete" })}
                >
                  <Trash2 size={16} />
                  Удалить поездку
                </button>
              </div>
            </details>
          ) : null}
        </div>
        <input
          ref={importInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => void uploadPlan(e.target.files?.[0])}
        />
        <input
          ref={backupInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => void uploadBackup(e.target.files?.[0])}
        />
        {error ? (
          <div className="global-error" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Закрыть сообщение"
              onClick={() => setError("")}
            >
              <X size={17} />
            </button>
          </div>
        ) : null}
        {loading ? (
          <div className="loading-state">
            <span className="brand-mark" />
            <p>Открываем ваши поездки…</p>
          </div>
        ) : trip ? (
          <>
            <header className="trip-heading">
              <div>
                <h1>{trip.title}</h1>
                <p className="trip-period">
                  {formatDate(trip.startDate)} —{" "}
                  {formatDate(trip.endDate, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                  <span>·</span>
                  {days.length}{" "}
                  {days.length === 1
                    ? "день"
                    : days.length < 5
                      ? "дня"
                      : "дней"}
                </p>
              </div>
              <div className="trip-heading-actions">
                <button
                  className="button primary"
                  onClick={() => setEditor({ type: "event" })}
                  disabled={busy}
                >
                  <Plus size={20} />
                  Добавить событие
                </button>
              </div>
            </header>
            <nav className="tab-bar" aria-label="Разделы поездки">
              {(
                [
                  { id: "plan", label: "План поездки" },
                  { id: "tickets", label: "Билеты" },
                  { id: "stays", label: "Проживание" },
                  { id: "people", label: "Люди" },
                  { id: "documents", label: "Документы" },
                  { id: "places", label: "Места" },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  className={tab === t.id ? "tab active" : "tab"}
                  aria-current={tab === t.id ? "page" : undefined}
                  onClick={() => {
                    setTab(t.id);
                    if (t.id === "documents") setDocEvent(undefined);
                  }}
                >
                  {t.label}
                  {t.id === "documents" && documents.length ? (
                    <span className="tab-count">{documents.length}</span>
                  ) : null}
                </button>
              ))}
            </nav>
            {tab === "plan" ? (
              <div className="plan-layout">
                <div className="plan-main">
                  <div className="day-selector" aria-label="Выбрать день">
                    {days.map((day) => (
                      <button
                        key={day}
                        aria-pressed={selectedDate === day}
                        className={
                          selectedDate === day ? "day selected" : "day"
                        }
                        onClick={() => setDate(day)}
                      >
                        <strong>{formatDate(day, { day: "numeric" })}</strong>
                        <span>{formatDate(day, { weekday: "short" })}</span>
                      </button>
                    ))}
                  </div>
                  <Timeline
                    trip={trip}
                    date={selectedDate}
                    documents={documents}
                    onEdit={(item) => setEditor({ type: "event", item })}
                    onAdd={() => setEditor({ type: "event" })}
                    onDocuments={showDocuments}
                  />
                </div>
                <aside className="trip-summary">
                  <h2>Всё под рукой</h2>
                  {[
                    {
                      kind: "tickets",
                      title: "Билеты",
                      description: "Билеты и детали перелёта",
                      Icon: Plane,
                    },
                    {
                      kind: "stays",
                      title: "Проживание",
                      description: "Отель, адрес и бронирование",
                      Icon: BedDouble,
                    },
                    {
                      kind: "people",
                      title: "Люди",
                      description: "Пассажиры и гости поездки",
                      Icon: Users,
                    },
                  ].map(({ kind, title, description, Icon }) => (
                    <button
                      className="summary-row"
                      key={kind}
                      onClick={() => {
                        setTab(kind as Tab);
                      }}
                    >
                      <span className="event-icon">
                        <Icon size={22} strokeWidth={1.7} />
                      </span>
                      <span>
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                  <div className="local-panel">
                    <Laptop size={24} strokeWidth={1.7} />
                    <div>
                      <h3>Поездка на этом устройстве</h3>
                      <p>
                        План и документы хранятся в этом браузере.{" "}
                        {offlineReady
                          ? "Можно открыть без интернета."
                          : "Облачная синхронизация ещё не подключена."}
                      </p>
                    </div>
                  </div>
                  {trip.id === sampleTrip.id ? (
                    <p className="sample-note">
                      Это пример поездки. Изменяйте его или{" "}
                      <button
                        className="text-button"
                        onClick={() => setEditor({ type: "trip" })}
                      >
                        создайте свою
                      </button>
                      .
                    </p>
                  ) : null}
                  <button
                    className="export-link text-button"
                    onClick={download}
                  >
                    <Download size={15} />
                    Сохранить копию плана
                  </button>
                  <p className="export-hint">
                    JSON-файл · без прикреплённых документов
                  </p>
                </aside>
              </div>
            ) : tab === "tickets" ? (
              <Tickets
                trip={trip}
                documents={documents}
                onEdit={(item) => setEditor({ type: "event", item })}
                onAdd={() => setEditor({ type: "event", kind: "flight" })}
                onDocuments={showDocuments}
              />
            ) : tab === "stays" ? (
              <Accommodation
                trip={trip}
                documents={documents}
                onEdit={(item) => setEditor({ type: "event", item })}
                onAdd={() => setEditor({ type: "event", kind: "stay" })}
                onDocuments={showDocuments}
              />
            ) : tab === "people" ? (
              <People
                trip={trip}
                documents={documents}
                onPeopleApplied={async () => {
                  setTrips(await loadTrips());
                  await refreshDocuments();
                }}
                onEditMembers={() => setEditor({ type: "members" })}
                onOpenRooms={() => {
                  setRoomsOpen(true);
                  document
                    .getElementById("rooms-hub")
                    ?.scrollIntoView({ behavior: "smooth" });
                }}
                onEvent={(item) => setEditor({ type: "event", item })}
                onDocuments={showDocuments}
              />
            ) : tab === "documents" ? (
              <Documents
                key={`${trip.id}-${docEvent ?? "all"}`}
                trip={trip}
                documents={documents}
                eventId={docEvent}
                onRefresh={refreshDocuments}
                onImported={recognitionImported}
                onProcessing={recognitionProcessing}
                onPlan={(eventId) => {
                  const item = trip.events.find(
                    (event) => event.id === eventId,
                  );
                  if (item) setDate(item.date);
                  setTab("plan");
                }}
              />
            ) : (
              <Places
                trip={trip}
                onEdit={(item) => setEditor({ type: "event", item })}
                onAdd={() => setEditor({ type: "event" })}
              />
            )}
          </>
        ) : (
          <div className="empty-trips">
            <span className="event-icon">
              <Luggage size={35} />
            </span>
            <h1>
              {error ? "Не удалось открыть поездки" : "Ваша следующая история"}
            </h1>
            <p>
              {error
                ? "Разрешите сайту хранить данные в браузере и попробуйте перезагрузить страницу."
                : "Создайте поездку, добавьте билеты и соберите всё, что пригодится в пути."}
            </p>
            <button
              className="button primary"
              onClick={() => setEditor({ type: "trip" })}
            >
              <Plus size={19} />
              Создать поездку
            </button>
            <button
              className="text-button"
              onClick={() => importInput.current?.click()}
            >
              <Upload size={16} />
              Импортировать сохранённый план
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => backupInput.current?.click()}
            >
              <Upload size={16} /> Восстановить копию с документами
            </button>
          </div>
        )}
        <footer className="main-footer">
          <span>Билеты и брони хранятся на этом устройстве.</span>
          <span>{offlineReady ? "Доступно без интернета" : "вместе"}</span>
        </footer>
      </main>
      {toast ? (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{toast}</span>
          <button
            className="icon-button"
            onClick={() => setToast("")}
            aria-label="Закрыть уведомление"
          >
            <X size={16} />
          </button>
        </div>
      ) : null}
      {editor?.type === "trip" ? (
        <TripEditor
          item={
            editor.item
              ? trips.find((item) => item.id === editor.item?.id)
              : undefined
          }
          onClose={() => setEditor(null)}
          onSave={async (next) => {
            await commit(next);
            selectTrip(next);
          }}
        />
      ) : editor?.type === "event" && trip ? (
        <EventEditor
          trip={trip}
          date={selectedDate}
          item={editor.item}
          initialKind={editor.kind}
          onSave={saveEvent}
          onDelete={deleteEvent}
          onClose={() => setEditor(null)}
        />
      ) : editor?.type === "members" && trip ? (
        <MembersEditor
          trip={trip}
          onSave={commit}
          onClose={() => setEditor(null)}
        />
      ) : editor?.type === "delete" && trip ? (
        <Dialog title="Удалить поездку?" onClose={() => setEditor(null)}>
          <p className="muted">
            «{trip.title}», все события и прикреплённые файлы будут удалены из
            этого браузера. Это действие нельзя отменить.
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              onClick={() => setEditor(null)}
              disabled={busy}
            >
              Оставить
            </button>
            <button
              className="button danger"
              onClick={() => void deleteTrip()}
              disabled={busy}
            >
              {busy ? "Удаляем…" : "Удалить поездку"}
            </button>
          </div>
        </Dialog>
      ) : editor?.type === "about" ? (
        <Dialog title="Ваш план под рукой" onClose={() => setEditor(null)}>
          <div className="about-copy">
            <p>
              Это первая локальная версия Вместе. Создавайте поездки, добавляйте
              события, адреса и файлы билетов.
            </p>
            <p>
              Данные хранятся только в этом браузере. Очистка данных сайта
              удалит их. Сохраните резервную копию с документами через меню
              поездки. Обычный JSON-экспорт содержит только план. Копия содержит
              личные документы: храните её в надёжном месте.
            </p>
            <p>
              Имена участников помогают распределять события. Приглашения и
              синхронизация между устройствами пока не подключены. Билеты и
              бронь отеля распознаются при загрузке. Основной способ — через
              локальный Codex CLI с твоим аккаунтом и его лимитами. Для этого
              нужен интернет; результат сохраняется здесь.
            </p>
            <p>
              {offlineReady
                ? "Приложение подготовлено к открытию без интернета на этом устройстве. Внешние карты требуют подключения."
                : "Для первого открытия нужен интернет или доступ к локальному серверу. В режиме разработки офлайн-запуск не включён."}
            </p>
          </div>
          <button className="button primary" onClick={() => setEditor(null)}>
            Понятно
          </button>
        </Dialog>
      ) : null}
    </div>
  );
}
