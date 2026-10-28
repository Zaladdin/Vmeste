"use client";
import {
  BedDouble,
  Plane,
  Footprints,
  TrainFront,
  Plus,
  Ellipsis,
  MapPin,
  Paperclip,
  ArrowUpRight,
} from "lucide-react";
import {
  eventKinds,
  eventsForDay,
  isArrivalOnDay,
  formatDate,
  mapLink,
  linkedEventIds,
  type Trip,
  type TripEvent,
  type StoredDocument,
} from "@/lib/model";
export const kindIcons = {
  flight: Plane,
  stay: BedDouble,
  activity: Footprints,
  transport: TrainFront,
};
export function Timeline({
  trip,
  date,
  documents,
  onEdit,
  onAdd,
  onDocuments,
}: {
  trip: Trip;
  date: string;
  documents: StoredDocument[];
  onEdit: (item: TripEvent) => void;
  onAdd: () => void;
  onDocuments: (eventId: string) => void;
}) {
  const events = eventsForDay(trip.events, date);
  const overnight = trip.events.filter(
    (e) =>
      e.kind === "stay" &&
      e.date < date &&
      e.endLocal &&
      e.endLocal.slice(0, 10) >= date,
  );
  return (
    <section className="timeline" aria-label="События выбранного дня">
      <h2 className="day-heading">
        {formatDate(date, { weekday: "long", day: "numeric", month: "long" })}
      </h2>
      {overnight.map((e) => (
        <div className="ongoing-stay" key={e.id}>
          <BedDouble size={18} />
          <span>
            {e.details.split("\n")[0] || e.title}
            {e.endLocal?.startsWith(date)
              ? ` · выселение в ${e.endLocal.slice(11)}`
              : " · проживание"}
          </span>
          <button className="text-button" onClick={() => onEdit(e)}>
            Детали
          </button>
        </div>
      ))}
      {!events.length ? (
        <div className="empty-day">
          <span className="empty-icon">
            <Footprints size={28} />
          </span>
          <h3>День для новых впечатлений</h3>
          <p>
            Добавьте место, прогулку или переезд.
            <br />
            Можно оставить время для спонтанных планов.
          </p>
        </div>
      ) : (
        <div className="event-list">
          {events.map((item) => {
            const arrival = isArrivalOnDay(item, date);
            const local = arrival
              ? item.endLocal!
              : `${item.date}T${item.time}`;
            const zone = arrival ? item.endTimeZone! : item.timeZone;
            const Icon = kindIcons[item.kind];
            const docs = documents.filter((d) =>
              linkedEventIds(d).includes(item.id),
            );
            return (
              <article className={`event-row event-${item.kind}`} key={item.id}>
                <time className="event-time" dateTime={local}>
                  {local.slice(11)}
                  <span title={zone}>
                    {zone.split("/").pop()?.replaceAll("_", " ")}
                  </span>
                </time>
                <span className="timeline-dot" />
                <span className="event-icon">
                  <Icon size={22} strokeWidth={1.7} />
                </span>
                <div className="event-body">
                  <div className="event-title-row">
                    <button
                      className="event-title"
                      onClick={() => onEdit(item)}
                    >
                      {arrival
                        ? `${item.kind === "flight" ? "Прилёт" : "Прибытие"}: `
                        : ""}
                      {item.title}
                    </button>
                    <button
                      className="icon-button attach-event"
                      aria-label={`Документы: ${item.title}`}
                      title={
                        docs.length
                          ? `Документы: ${docs.length}`
                          : "Прикрепить документ"
                      }
                      onClick={() => onDocuments(item.id)}
                    >
                      <Paperclip size={16} />
                    </button>
                    <button
                      className="icon-button edit-event"
                      aria-label={`Редактировать: ${item.title}`}
                      onClick={() => onEdit(item)}
                    >
                      <Ellipsis size={20} />
                    </button>
                  </div>
                  {item.details ? (
                    <p className="event-details">{item.details}</p>
                  ) : null}
                  {arrival ? (
                    <div className="event-end">
                      Отправление: {formatDate(item.date)}, {item.time} ·{" "}
                      {item.timeZone.split("/").pop()?.replaceAll("_", " ")}
                    </div>
                  ) : item.endLocal ? (
                    <div className="event-end">
                      {item.kind === "flight"
                        ? "Прилёт"
                        : item.kind === "stay"
                          ? "Выселение"
                          : "Окончание"}
                      :{" "}
                      {item.endLocal.slice(0, 10) !== date
                        ? `${formatDate(item.endLocal.slice(0, 10))}, `
                        : ""}
                      {item.endLocal.slice(11)}{" "}
                      <span>
                        ·{" "}
                        {item.endTimeZone
                          ?.split("/")
                          .pop()
                          ?.replaceAll("_", " ")}
                      </span>
                    </div>
                  ) : null}
                  {item.location && item.kind !== "flight" ? (
                    <a
                      className="location-link"
                      href={mapLink(item.location)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MapPin size={15} />
                      <span>{item.location}</span>
                      <ArrowUpRight size={13} />
                    </a>
                  ) : null}
                  {docs.length ? (
                    <button
                      className="document-link"
                      onClick={() => onDocuments(item.id)}
                    >
                      <Paperclip size={14} />
                      Документы · {docs.length}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <button className="add-day-button" onClick={onAdd}>
        <Plus size={20} />
        Добавить в этот день
      </button>
    </section>
  );
}
export function Places({
  trip,
  onEdit,
  onAdd,
}: {
  trip: Trip;
  onEdit: (item: TripEvent) => void;
  onAdd: () => void;
}) {
  const places = trip.events.filter((e) => e.location);
  return (
    <section className="places-section">
      <div className="section-heading">
        <div>
          <h2>Места поездки</h2>
          <p className="muted">
            Адреса из вашего плана. Маршрут откроется в Google Maps.
          </p>
        </div>
        <button className="button secondary" onClick={onAdd}>
          <Plus size={17} />
          Добавить место
        </button>
      </div>
      {places.length ? (
        places.map((item) => {
          const Icon = kindIcons[item.kind];
          return (
            <article className="place-row" key={item.id}>
              <span className="event-icon">
                <Icon size={22} />
              </span>
              <div>
                <button className="event-title" onClick={() => onEdit(item)}>
                  {item.title}
                </button>
                <p className="muted">{item.location}</p>
                <small>
                  {formatDate(item.date)} · {eventKinds[item.kind]}
                </small>
              </div>
              <a
                className="button secondary"
                href={mapLink(item.location)}
                target="_blank"
                rel="noreferrer"
              >
                На карте
                <ArrowUpRight size={16} />
              </a>
            </article>
          );
        })
      ) : (
        <div className="empty-day">
          <MapPin size={30} />
          <h3>Здесь будут ваши места</h3>
          <p>Добавьте событие с адресом — оно появится в этом списке.</p>
        </div>
      )}
    </section>
  );
}
