"use client";

import { useEffect, useRef, useState } from "react";
import { Users, Plus, RefreshCw, LogIn, ShieldCheck } from "lucide-react";
import type { Trip } from "@/lib/model";
import { formatDate, eventKinds, instantOf } from "@/lib/model";
import {
  roomCapabilities,
  listRooms,
  readRoom,
  createRoom,
  joinRoom,
  publishRoom,
  linkRoomPerson,
  rotateRoomInvite,
  leaveRoom,
  removeRoomMember,
  deleteRoom,
  type RoomSummary,
  type TripRoom,
} from "@/lib/room-client";
import { Dialog } from "./dialog";
import { CopyValue } from "./copy-value";
import "./rooms.css";

export function RoomsHub({
  userId,
  trip,
  open,
  onToggle,
}: {
  userId: string;
  trip?: Trip;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<TripRoom | null>(null);
  const [invite, setInvite] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const alive = useRef(false);
  const operation = useRef(0);
  const roomId = room?.id;

  useEffect(() => {
    alive.current = true;
    let active = true;
    setAvailable(null);
    setRooms([]);
    (async () => {
      try {
        const ready = await roomCapabilities(userId);
        if (!active) return;
        setAvailable(ready);
        if (ready) {
          const items = await listRooms(userId);
          if (active) {
            setRooms(items);
            setError("");
          }
        }
      } catch {
        if (active) {
          setAvailable(false);
          setError(
            "Комнаты пока недоступны. Проверьте подключение и настройку облака.",
          );
        }
      }
    })();
    return () => {
      active = false;
      alive.current = false;
      operation.current++;
    };
  }, [userId, retry]);

  useEffect(() => {
    if (!roomId) return;
    let active = true,
      pending = false;
    async function refresh() {
      if (pending || busy) return;
      pending = true;
      try {
        const latest = await readRoom(userId, roomId!);
        if (active)
          setRoom((current) => (current?.id === latest.id ? latest : current));
      } catch {
        if (active) {
          setRoom(null);
          setInvite("");
          setLinks({});
          setRooms([]);
          setError(
            "Не удалось подтвердить доступ к комнате. Обновите список и откройте её снова.",
          );
        }
      } finally {
        pending = false;
      }
    }
    const timer = setInterval(() => void refresh(), 15000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    window.addEventListener("online", focus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", focus);
    };
  }, [userId, roomId, busy]);

  async function refreshList() {
    const items = await listRooms(userId);
    if (alive.current) setRooms(items);
  }
  async function run<T>(task: () => Promise<T>, apply: (value: T) => void) {
    if (busy) return;
    const version = ++operation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await task();
      if (!alive.current || version !== operation.current) return;
      apply(value);
      try {
        await refreshList();
      } catch {
        if (alive.current) setRooms([]);
      }
    } catch (failure) {
      if (alive.current && version === operation.current) {
        setRoom(null);
        setInvite("");
        setLinks({});
        setRooms([]);
        setError(
          failure instanceof Error
            ? failure.message
            : "Не удалось выполнить действие. Попробуйте ещё раз.",
        );
      }
    } finally {
      if (alive.current && version === operation.current) setBusy(false);
    }
  }
  function showRoom(value: TripRoom) {
    setRoom(value);
    setLinks({});
    setInvite("");
  }
  function closeRoom() {
    operation.current++;
    setRoom(null);
    setLinks({});
    setInvite("");
    setBusy(false);
  }
  const owner = room?.owner_id === userId;

  return (
    <details
      id="rooms-hub"
      className="rooms-hub"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        <Users size={19} />
        <span>Комнаты поездок</span>
        <small>{rooms.length || "Пригласить друзей"}</small>
      </summary>
      <div className="rooms-content">
        <p>
          Личные поездки доступны только вам. В комнате участники видят
          опубликованный общий план; изменения публикует организатор.
        </p>
        {available === null ? (
          <p role="status">Проверяем комнаты…</p>
        ) : !available ? (
          <div className="rooms-setup">
            <p>
              Комнаты ещё не подключены к базе. ID аккаунта уже доступен вверху
              страницы.
            </p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setRetry((value) => value + 1)}
            >
              Проверить подключение
            </button>
          </div>
        ) : (
          <>
            <form
              className="room-join"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () => joinRoom(userId, joinCode),
                  (value) => {
                    showRoom(value);
                    setJoinCode("");
                  },
                );
              }}
            >
              <label>
                Код комнаты
                <input
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value)}
                  maxLength={80}
                  required
                  placeholder="Вставьте код от организатора"
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
              <button
                className="button primary"
                disabled={busy || !joinCode.trim()}
              >
                <LogIn size={17} />
                Войти в комнату
              </button>
            </form>
            {trip ? (
              <div className="room-create">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => createRoom(userId, trip),
                      (value) => {
                        showRoom(value.room);
                        setInvite(value.invite_code);
                      },
                    )
                  }
                >
                  <Plus size={17} />
                  Создать комнату этой поездки
                </button>
                <small>
                  Будут опубликованы план «{trip.title}», имена участников и
                  заметки. Оригиналы билетов и брони не передаются.
                </small>
              </div>
            ) : (
              <p className="muted">
                Чтобы создать свою комнату, сначала добавьте поездку. В чужую
                комнату можно войти сразу по коду.
              </p>
            )}
            <div className="room-list">
              {rooms.map((item) => (
                <button
                  className="room-pick"
                  key={item.id}
                  disabled={busy}
                  onClick={() =>
                    void run(() => readRoom(userId, item.id), showRoom)
                  }
                >
                  <Users size={18} />
                  <span>
                    {item.title}
                    <small>
                      {item.owner_id === userId
                        ? "Вы — организатор"
                        : "Участник комнаты"}
                    </small>
                  </span>
                </button>
              ))}
              {!rooms.length ? (
                <p className="muted">У вас пока нет комнат.</p>
              ) : null}
            </div>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void run(() => listRooms(userId), setRooms)}
            >
              <RefreshCw size={15} />
              Обновить список
            </button>
          </>
        )}
        {busy ? <p role="status">Сохраняем и проверяем доступ…</p> : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
      </div>
      {room ? (
        <Dialog title={room.trip.title} onClose={closeRoom} wide>
          <div className="room-detail">
            <p className="room-role">
              <ShieldCheck size={17} />
              {owner
                ? "Вы — организатор. Только вы меняете общий план и привязки участников."
                : "Общий план для участников комнаты. Личные поездки других аккаунтов недоступны."}
            </p>
            <CopyValue label="ID комнаты" value={room.id} />
            <p className="muted">
              Для входа нужен код приглашения. Сам ID комнаты доступ не
              открывает.
            </p>
            <div className="room-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(() => readRoom(userId, room.id), showRoom)
                }
              >
                <RefreshCw size={16} />
                Обновить комнату
              </button>
              {owner ? (
                <>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        async () => {
                          const result = await rotateRoomInvite(
                            userId,
                            room.id,
                          );
                          return {
                            ...result,
                            room: await readRoom(userId, room.id),
                          };
                        },
                        (value) => {
                          showRoom(value.room);
                          setInvite(value.invite_code);
                          setNotice(
                            "Новый код готов. Прежний код больше не действует.",
                          );
                        },
                      )
                    }
                  >
                    Новый код приглашения
                  </button>
                  {trip?.id === room.trip.id ? (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            publishRoom(userId, room.id, trip, room.revision),
                          showRoom,
                        )
                      }
                    >
                      Опубликовать изменения поездки
                    </button>
                  ) : null}
                </>
              ) : (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => leaveRoom(userId, room.id),
                      () => {
                        closeRoom();
                        setNotice("Вы вышли из комнаты.");
                      },
                    )
                  }
                >
                  Выйти из комнаты
                </button>
              )}
            </div>
            {invite ? (
              <div className="room-invite">
                <CopyValue label="Код приглашения" value={invite} />
                <p>
                  Отправьте этот код друзьям. Они войдут в свой аккаунт и
                  вставят его в разделе «Комнаты поездок». Сохраните код сейчас;
                  после закрытия его можно будет только заменить новым.
                </p>
              </div>
            ) : null}
            <h3>Люди из поездки</h3>
            <p>
              У каждого человека свой ID. Организатор связывает человека с
              аккаунтом после входа этого аккаунта в комнату.
            </p>
            <div className="room-people">
              {room.trip.members.map((person) => {
                const binding =
                  room.links.find((link) => link.person_id === person.id)
                    ?.user_id ?? "";
                const choice = links[person.id] ?? binding;
                return (
                  <article key={person.id} className="room-person">
                    <h4>{person.name}</h4>
                    <CopyValue label="ID участника" value={person.id} />
                    {binding ? (
                      <CopyValue label="ID аккаунта" value={binding} />
                    ) : (
                      <p className="muted">Аккаунт пока не связан.</p>
                    )}
                    {owner ? (
                      <div className="room-link">
                        <label>
                          Аккаунт для {person.name}
                          <select
                            aria-label={`Аккаунт для ${person.name}`}
                            value={choice}
                            disabled={busy}
                            onChange={(event) =>
                              setLinks((current) => ({
                                ...current,
                                [person.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Без привязки</option>
                            {room.members.map((member) => (
                              <option
                                key={member.user_id}
                                value={member.user_id}
                                disabled={room.links.some(
                                  (link) =>
                                    link.user_id === member.user_id &&
                                    link.person_id !== person.id,
                                )}
                              >
                                {member.user_id === userId
                                  ? "Мой аккаунт"
                                  : `Аккаунт ${member.user_id.slice(0, 8)}`}{" "}
                                · {member.user_id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="button secondary"
                          disabled={busy || choice === binding}
                          onClick={() =>
                            void run(
                              () =>
                                linkRoomPerson(
                                  userId,
                                  room.id,
                                  person.id,
                                  choice || null,
                                  room.revision,
                                ),
                              showRoom,
                            )
                          }
                        >
                          Сохранить привязку
                        </button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
              {!room.trip.members.length ? (
                <p className="muted">В плане пока не указаны люди.</p>
              ) : null}
            </div>
            <h3>Аккаунты в комнате</h3>
            <div className="room-roster">
              {room.members.map((member) => (
                <div key={member.user_id}>
                  <strong>
                    {room.links.find((link) => link.user_id === member.user_id)
                      ? room.trip.members.find(
                          (person) =>
                            person.id ===
                            room.links.find(
                              (link) => link.user_id === member.user_id,
                            )?.person_id,
                        )?.name
                      : member.user_id === room.owner_id
                        ? "Организатор"
                        : "Участник"}
                    {member.user_id === userId ? " · Вы" : ""}
                  </strong>
                  <CopyValue label="ID аккаунта" value={member.user_id} />
                  {owner && member.user_id !== userId ? (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Удалить участника из комнаты? Его привязка будет снята, а прежний код приглашения перестанет действовать.",
                          )
                        )
                          void run(
                            () =>
                              removeRoomMember(userId, room.id, member.user_id),
                            showRoom,
                          );
                      }}
                    >
                      Удалить из комнаты
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <h3>Общий план</h3>
            <p>
              {room.trip.destination} · {formatDate(room.trip.startDate)} —{" "}
              {formatDate(room.trip.endDate)}
            </p>
            <div className="room-plan">
              {[...room.trip.events]
                .sort(
                  (a, b) =>
                    instantOf(`${a.date}T${a.time}`, a.timeZone) -
                    instantOf(`${b.date}T${b.time}`, b.timeZone),
                )
                .map((event) => (
                  <article key={event.id}>
                    <small>
                      {eventKinds[event.kind]} · {formatDate(event.date)} ·{" "}
                      {event.time} ({event.timeZone})
                    </small>
                    <h4>{event.title}</h4>
                    {event.endLocal ? (
                      <p>
                        Окончание: {event.endLocal.replace("T", " ")} (
                        {event.endTimeZone})
                      </p>
                    ) : null}
                    {event.location ? <p>{event.location}</p> : null}
                    {event.details ? (
                      <p className="room-event-notes">{event.details}</p>
                    ) : null}
                    <small>
                      {event.memberIds
                        .map(
                          (id) =>
                            room.trip.members.find((person) => person.id === id)
                              ?.name,
                        )
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </article>
                ))}
              {!room.trip.events.length ? (
                <p className="muted">События ещё не опубликованы.</p>
              ) : null}
            </div>
            <p className="muted">
              Версия плана: {room.revision}. Оригиналы документов остаются
              личными.
            </p>
            {owner ? (
              <button
                className="button danger-quiet"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Удалить комнату для всех участников? Личная поездка и документы сохранятся.",
                    )
                  )
                    void run(
                      () => deleteRoom(userId, room.id),
                      () => {
                        closeRoom();
                        setNotice("Комната удалена. Личная поездка сохранена.");
                      },
                    );
                }}
              >
                Удалить комнату
              </button>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </details>
  );
}
