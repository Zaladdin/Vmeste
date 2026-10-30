"use client";

import {
  ArrowRight,
  ArrowUpRight,
  BedDouble,
  FileText,
  MapPin,
  Plane,
  Plus,
  TrainFront,
  Users,
} from "lucide-react";
import {
  formatDate,
  instantOf,
  linkedEventIds,
  mapLink,
  type StoredDocument,
  type Trip,
  type TripEvent,
} from "@/lib/model";
import { documentPeople, matchingPersonIds } from "@/lib/document-people";
import "./trip-sections.css";
import { PeopleDiscovery } from "./people-discovery";
import { CopyValue } from "./copy-value";
import { PeopleDuplicates } from "./people-duplicates";

type SectionProps = {
  trip: Trip;
  documents: StoredDocument[];
  onEdit: (event: TripEvent) => void;
  onAdd: () => void;
  onDocuments: (eventId?: string) => void;
};

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase("ru");
}

function notes(event: TripEvent): string {
  return event.details
    .split(/\r?\n/u)
    .filter((line) => !/^\s*Участники\s*:/iu.test(line))
    .join("\n");
}

function ordered(events: TripEvent[]): TripEvent[] {
  return [...events].sort(
    (a, b) =>
      instantOf(`${a.date}T${a.time}`, a.timeZone) -
      instantOf(`${b.date}T${b.time}`, b.timeZone),
  );
}

function SectionHeading({
  title,
  action,
  onAdd,
}: {
  title: string;
  action: string;
  onAdd: () => void;
}) {
  return (
    <div className="travel-section-heading">
      <h2>{title}</h2>
      <button className="button secondary" onClick={onAdd}>
        <Plus size={19} />
        {action}
      </button>
    </div>
  );
}

function PeopleStrip({
  trip,
  event,
  label,
}: {
  trip: Trip;
  event: TripEvent;
  label: string;
}) {
  const people = trip.members.filter((person) =>
    event.memberIds.includes(person.id),
  );
  return (
    <div className="booking-people">
      <span className="booking-people-label">{label}</span>
      {people.length ? (
        people.map((person) => (
          <span className="booking-person" key={person.id}>
            <span className="person-initials" aria-hidden="true">
              {initials(person.name)}
            </span>
            <span>{person.name}</span>
          </span>
        ))
      ) : (
        <span className="booking-people-empty">Не указаны</span>
      )}
    </div>
  );
}

function DocumentStub({
  event,
  documents,
  onDocuments,
}: Pick<SectionProps, "documents" | "onDocuments"> & { event: TripEvent }) {
  const count = documents.filter((doc) =>
    linkedEventIds(doc).includes(event.id),
  ).length;
  return (
    <div className="booking-document">
      <FileText size={32} strokeWidth={1.6} aria-hidden="true" />
      <span>{count ? "Документы" : "Документ"}</span>
      <button
        className="button secondary"
        onClick={() => onDocuments(event.id)}
        aria-label={`${count ? "Документы" : "Прикрепить документ"}: ${event.title}`}
      >
        {count ? "Открыть" : "Прикрепить"}
      </button>
    </div>
  );
}

function EmptyBookings({
  kind,
  onAdd,
  onDocuments,
}: {
  kind: "tickets" | "stays";
  onAdd: () => void;
  onDocuments: () => void;
}) {
  const Icon = kind === "tickets" ? Plane : BedDouble;
  return (
    <div className="travel-empty">
      <span
        className={`travel-empty-icon ${kind === "stays" ? "hotel-tone" : ""}`}
      >
        <Icon size={30} strokeWidth={1.5} />
      </span>
      <h3>
        {kind === "tickets"
          ? "Все билеты — в одном месте"
          : "Здесь будут ваши отели"}
      </h3>
      <p>
        {kind === "tickets"
          ? "Добавьте перелёт или переезд вручную либо загрузите билет."
          : "Добавьте проживание или загрузите подтверждение бронирования."}
      </p>
      <div className="travel-empty-actions">
        <button className="button primary" onClick={onDocuments}>
          <FileText size={18} />
          Загрузить документ
        </button>
        <button className="button secondary" onClick={onAdd}>
          <Plus size={18} />
          Добавить вручную
        </button>
      </div>
    </div>
  );
}

export function Tickets({
  trip,
  documents,
  onEdit,
  onAdd,
  onDocuments,
}: SectionProps) {
  const events = ordered(
    trip.events.filter(
      (event) => event.kind === "flight" || event.kind === "transport",
    ),
  );
  return (
    <section className="travel-section" aria-label="Билеты поездки">
      <SectionHeading title="Билеты" action="Добавить билет" onAdd={onAdd} />
      {events.length ? (
        <div className="booking-list">
          {events.map((event) => {
            const Icon = event.kind === "flight" ? Plane : TrainFront;
            const route = event.title.split(/\s*(?:→| — )\s*/u);
            const hasRoute = route.length === 2;
            return (
              <article className="booking-card ticket-card" key={event.id}>
                <div className="booking-main">
                  <header className="booking-heading">
                    <span className="booking-symbol">
                      <Icon size={26} strokeWidth={1.7} />
                    </span>
                    <div>
                      <button
                        className="booking-title"
                        onClick={() => onEdit(event)}
                      >
                        {event.title}
                      </button>
                      {notes(event) ? (
                        <p className="booking-notes">{notes(event)}</p>
                      ) : null}
                    </div>
                  </header>
                  <div className="ticket-journey">
                    <div className="ticket-stop">
                      <time
                        className="ticket-clock"
                        aria-label={`Отправление: ${event.time}`}
                        dateTime={`${event.date}T${event.time}`}
                      >
                        {event.time}
                      </time>
                      {hasRoute ? <strong>{route[0]}</strong> : null}
                      <span>
                        {formatDate(event.date, {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        })}
                      </span>
                      <small>{event.timeZone}</small>
                    </div>
                    <div className="ticket-path" aria-hidden="true">
                      <span />
                      <Icon size={22} />
                      <span />
                      <ArrowRight size={17} />
                    </div>
                    <div className="ticket-stop ticket-stop-end">
                      {event.endLocal ? (
                        <>
                          <time
                            className="ticket-clock"
                            aria-label={`Прибытие: ${event.endLocal.slice(11)}`}
                            dateTime={event.endLocal}
                          >
                            {event.endLocal.slice(11)}
                          </time>
                          {hasRoute ? <strong>{route[1]}</strong> : null}
                          <span>
                            {formatDate(event.endLocal.slice(0, 10), {
                              day: "numeric",
                              month: "long",
                              year: "numeric",
                            })}
                          </span>
                          <small>{event.endTimeZone}</small>
                        </>
                      ) : (
                        <span className="ticket-time-unknown">
                          Время не указано
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <DocumentStub
                  event={event}
                  documents={documents}
                  onDocuments={onDocuments}
                />
                <PeopleStrip trip={trip} event={event} label="Пассажиры" />
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyBookings
          kind="tickets"
          onAdd={onAdd}
          onDocuments={() => onDocuments()}
        />
      )}
    </section>
  );
}

export function Accommodation({
  trip,
  documents,
  onEdit,
  onAdd,
  onDocuments,
}: SectionProps) {
  const events = ordered(trip.events.filter((event) => event.kind === "stay"));
  return (
    <section className="travel-section" aria-label="Проживание в поездке">
      <SectionHeading
        title="Проживание"
        action="Добавить проживание"
        onAdd={onAdd}
      />
      {events.length ? (
        <div className="booking-list">
          {events.map((event) => (
            <article className="booking-card hotel-card" key={event.id}>
              <div className="booking-main">
                <header className="booking-heading">
                  <span className="booking-symbol hotel-tone">
                    <BedDouble size={26} strokeWidth={1.7} />
                  </span>
                  <div>
                    <button
                      className="booking-title"
                      onClick={() => onEdit(event)}
                    >
                      {event.title}
                    </button>
                    {notes(event) ? (
                      <p className="booking-notes">{notes(event)}</p>
                    ) : null}
                  </div>
                </header>
                <div className="stay-dates">
                  <div>
                    <span className="ticket-stop-label">Заселение</span>
                    <strong>
                      {formatDate(event.date, {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
                    </strong>
                    <time dateTime={`${event.date}T${event.time}`}>
                      {event.time} <small>· {event.timeZone}</small>
                    </time>
                  </div>
                  <ArrowRight size={20} aria-hidden="true" />
                  <div>
                    <span className="ticket-stop-label">Выселение</span>
                    {event.endLocal ? (
                      <>
                        <strong>
                          {formatDate(event.endLocal.slice(0, 10), {
                            day: "numeric",
                            month: "long",
                            year: "numeric",
                          })}
                        </strong>
                        <time dateTime={event.endLocal}>
                          {event.endLocal.slice(11)}{" "}
                          <small>· {event.endTimeZone}</small>
                        </time>
                      </>
                    ) : (
                      <span>Не указано</span>
                    )}
                  </div>
                </div>
                {event.location ? (
                  <a
                    className="stay-location"
                    href={mapLink(event.location)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MapPin size={17} />
                    <span>{event.location}</span>
                    <ArrowUpRight size={16} />
                  </a>
                ) : null}
              </div>
              <DocumentStub
                event={event}
                documents={documents}
                onDocuments={onDocuments}
              />
              <PeopleStrip trip={trip} event={event} label="Гости" />
            </article>
          ))}
        </div>
      ) : (
        <EmptyBookings
          kind="stays"
          onAdd={onAdd}
          onDocuments={() => onDocuments()}
        />
      )}
    </section>
  );
}

export function People({
  trip,
  documents,
  onEditMembers,
  onOpenRooms,
  onEvent,
  onDocuments,
  onPeopleApplied,
}: {
  trip: Trip;
  documents: StoredDocument[];
  onEditMembers: () => void;
  onOpenRooms: () => void;
  onEvent: (event: TripEvent) => void;
  onDocuments: (eventId?: string) => void;
  onPeopleApplied: (trip: Trip) => Promise<void>;
}) {
  return (
    <section className="travel-section" aria-label="Люди в поездке">
      <SectionHeading
        title="Люди"
        action="Управлять участниками"
        onAdd={onEditMembers}
      />
      <PeopleDuplicates trip={trip} onApplied={onPeopleApplied} />
      <PeopleDiscovery
        trip={trip}
        documents={documents}
        onApplied={onPeopleApplied}
      />
      <p className="muted">
        Свяжите людей из поездки с аккаунтами после приглашения в комнату.
      </p>
      <button className="button secondary" onClick={onOpenRooms}>
        Связать с аккаунтами в комнате
      </button>
      {trip.members.length ? (
        <div className="people-list">
          {trip.members.map((person) => {
            const events = ordered(
              trip.events.filter((event) =>
                event.memberIds.includes(person.id),
              ),
            );
            const sources = documents.filter(
              (document) =>
                document.people?.some(
                  (source) => source.memberId === person.id,
                ) ||
                document.recognition?.result?.events.some((event) =>
                  documentPeople(event.details).some((name) => {
                    const ids = matchingPersonIds(
                      name,
                      trip.members,
                      document.people ?? [],
                    );
                    return ids.length === 1 && ids[0] === person.id;
                  }),
                ),
            );
            return (
              <article className="person-card" key={person.id}>
                <CopyValue label="ID участника" value={person.id} />
                <div className="person-card-header">
                  <span
                    className="person-initials person-initials-large"
                    aria-hidden="true"
                  >
                    {initials(person.name)}
                  </span>
                  <div>
                    <h3>{person.name}</h3>
                    <p>
                      {sources.length ? "Указан в документах" : "В поездке"}
                    </p>
                  </div>
                </div>
                <div className="person-bookings">
                  {events.length ? (
                    events.map((event) => {
                      const Icon =
                        event.kind === "stay"
                          ? BedDouble
                          : event.kind === "flight"
                            ? Plane
                            : MapPin;
                      return (
                        <button key={event.id} onClick={() => onEvent(event)}>
                          <Icon size={17} />
                          <span>{event.title}</span>
                          <small>
                            {formatDate(event.date, {
                              day: "numeric",
                              month: "short",
                            })}
                          </small>
                        </button>
                      );
                    })
                  ) : (
                    <p className="person-no-events">
                      События пока не назначены
                    </p>
                  )}
                </div>
                {sources.length ? (
                  <div className="person-sources">
                    <span>Документы</span>
                    {sources.map((document) => (
                      <button
                        key={document.id}
                        onClick={() =>
                          onDocuments(
                            linkedEventIds(document).find((id) =>
                              events.some((event) => event.id === id),
                            ),
                          )
                        }
                      >
                        <FileText size={16} />
                        <span>{document.name}</span>
                        <ArrowUpRight size={15} />
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="travel-empty">
          <span className="travel-empty-icon">
            <Users size={30} strokeWidth={1.5} />
          </span>
          <h3>С кем отправимся в поездку?</h3>
          <p>
            Добавьте участников вручную. При распознавании билета или брони
            здесь появятся указанные в документе пассажиры и гости.
          </p>
          <button className="button primary" onClick={onEditMembers}>
            <Plus size={18} />
            Добавить участников
          </button>
        </div>
      )}
    </section>
  );
}
