import { z } from "zod";
import { getCloudClient } from "./cloud-client";
import { parseTrip, type Trip } from "./model";

const uuid = z.uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const summarySchema = z
  .object({
    id: uuid,
    owner_id: uuid,
    title: z.string().trim().min(1).max(160),
    revision,
    updated_at: timestamp,
  })
  .strict();
const roomSchema = z
  .object({
    id: uuid,
    owner_id: uuid,
    trip: z.unknown(),
    revision,
    updated_at: timestamp,
    members: z
      .array(z.object({ user_id: uuid, joined_at: timestamp }).strict())
      .min(1)
      .max(50),
    links: z
      .array(
        z
          .object({ person_id: z.string().min(1).max(100), user_id: uuid })
          .strict(),
      )
      .max(50),
  })
  .strict();
const inviteSchema = z
  .object({ invite_code: z.string().regex(/^[a-f0-9]{32}$/) })
  .strict();

export type RoomSummary = z.infer<typeof summarySchema>;
export type TripRoom = Omit<z.infer<typeof roomSchema>, "trip"> & {
  trip: Trip;
};

const messages = {
  ROOM_FORBIDDEN:
    "Нет доступа к этой комнате. Возможно, владелец удалил вас из участников.",
  ROOM_NOT_FOUND: "Комната не найдена или доступ к ней закрыт.",
  ROOM_INVALID_CODE:
    "Проверьте код комнаты. Возможно, владелец уже заменил его.",
  ROOM_CONFLICT: "Комната уже изменилась. Обновите её перед сохранением.",
  ROOM_LIMIT: "Достигнут предел комнат или участников.",
  ROOM_INVALID_TRIP: "Не удалось опубликовать план. Проверьте данные поездки.",
  ROOM_LINK_CONFLICT:
    "Этот участник или аккаунт уже связан. Сначала отмените прежнюю привязку.",
  ROOM_OWNER_CANNOT_LEAVE:
    "Владелец не может выйти из своей комнаты. Можно удалить комнату.",
  ROOM_AUTH_REQUIRED: "Войдите в нужный аккаунт и повторите действие.",
  ROOM_NOT_READY:
    "Комнаты ещё не подключены. Нужно завершить настройку Supabase.",
  ROOM_INVALID_RESPONSE:
    "Не удалось проверить ответ комнаты. Обновите страницу и повторите действие.",
  ROOM_UNAVAILABLE:
    "Не удалось связаться с комнатой. Проверьте интернет и повторите действие.",
} as const;
export type RoomErrorCode = keyof typeof messages;
export class RoomClientError extends Error {
  constructor(public readonly code: RoomErrorCode) {
    super(messages[code]);
    this.name = "RoomClientError";
  }
}
function fail(code: RoomErrorCode): never {
  throw new RoomClientError(code);
}
function validId(id: string) {
  if (!uuid.safeParse(id).success) fail("ROOM_INVALID_RESPONSE");
  return id;
}
function validRevision(value: number) {
  if (!revision.safeParse(value).success) fail("ROOM_CONFLICT");
  return value;
}
function checkedTrip(
  raw: unknown,
  code: "ROOM_INVALID_TRIP" | "ROOM_INVALID_RESPONSE",
) {
  try {
    const trip = parseTrip(raw);
    if (new TextEncoder().encode(JSON.stringify(trip)).byteLength > 1_048_576)
      fail(code);
    return trip;
  } catch {
    return fail(code);
  }
}
function safeRpcFailure(error: unknown): never {
  const parsed = z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .safeParse(error);
  if (parsed.success) {
    if (["PGRST202", "42883"].includes(parsed.data.code ?? ""))
      fail("ROOM_NOT_READY");
    const message = parsed.data.message;
    if (message && Object.hasOwn(messages, message))
      fail(message as RoomErrorCode);
    if (parsed.data.code === "42501") fail("ROOM_FORBIDDEN");
  }
  return fail("ROOM_UNAVAILABLE");
}

/** Pin the verified token: a later SDK account switch cannot send A's plan as B. */
async function rpc(
  userId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (!uuid.safeParse(userId).success) fail("ROOM_AUTH_REQUIRED");
  const sdk = getCloudClient();
  if (!sdk) fail("ROOM_NOT_READY");
  try {
    const session = await sdk.auth.getSession();
    const token = session.data.session?.access_token;
    if (session.error || !token) fail("ROOM_AUTH_REQUIRED");
    const verified = await sdk.auth.getUser(token);
    if (verified.error || verified.data.user?.id !== userId)
      fail("ROOM_AUTH_REQUIRED");
    const response = await sdk
      .rpc(name, args)
      .setHeader("Authorization", `Bearer ${token}`);
    if (response.error) safeRpcFailure(response.error);
    return response.data;
  } catch (error) {
    if (error instanceof RoomClientError) throw error;
    return fail("ROOM_UNAVAILABLE");
  }
}

function checkedRoom(
  data: unknown,
  userId: string,
  expectedId?: string,
): TripRoom {
  const parsed = roomSchema.safeParse(data);
  if (!parsed.success) fail("ROOM_INVALID_RESPONSE");
  const room = {
    ...parsed.data,
    trip: checkedTrip(parsed.data.trip, "ROOM_INVALID_RESPONSE"),
  };
  const members = new Set(room.members.map((member) => member.user_id));
  const people = new Set(room.trip.members.map((person) => person.id));
  if (
    (expectedId !== undefined && room.id !== expectedId) ||
    members.size !== room.members.length ||
    !members.has(userId) ||
    !members.has(room.owner_id) ||
    new Set(room.links.map((link) => link.person_id)).size !==
      room.links.length ||
    new Set(room.links.map((link) => link.user_id)).size !==
      room.links.length ||
    room.links.some(
      (link) => !members.has(link.user_id) || !people.has(link.person_id),
    )
  )
    fail("ROOM_INVALID_RESPONSE");
  return room;
}
function checkedOwnerRoom(data: unknown, userId: string, roomId?: string) {
  const room = checkedRoom(data, userId, roomId);
  if (room.owner_id !== userId) fail("ROOM_INVALID_RESPONSE");
  return room;
}

export async function roomCapabilities(userId: string): Promise<boolean> {
  const data = await rpc(userId, "trip_rooms_capability");
  if (
    !z
      .object({ version: z.literal(1) })
      .strict()
      .safeParse(data).success
  )
    fail("ROOM_NOT_READY");
  return true;
}
export async function listRooms(userId: string): Promise<RoomSummary[]> {
  const data = await rpc(userId, "list_trip_rooms");
  const parsed = z.array(summarySchema).max(100).safeParse(data);
  if (
    !parsed.success ||
    new Set(parsed.data.map((room) => room.id)).size !== parsed.data.length
  )
    fail("ROOM_INVALID_RESPONSE");
  return parsed.data;
}
export async function readRoom(
  userId: string,
  roomId: string,
): Promise<TripRoom> {
  return checkedRoom(
    await rpc(userId, "read_trip_room", { p_room_id: validId(roomId) }),
    userId,
    roomId,
  );
}
export async function createRoom(
  userId: string,
  trip: Trip,
): Promise<{ room: TripRoom; invite_code: string }> {
  const snapshot = checkedTrip(trip, "ROOM_INVALID_TRIP");
  const data = await rpc(userId, "create_trip_room", { p_trip: snapshot });
  const parsed = inviteSchema.extend({ room: z.unknown() }).safeParse(data);
  if (!parsed.success) fail("ROOM_INVALID_RESPONSE");
  const room = checkedOwnerRoom(parsed.data.room, userId);
  if (room.trip.id !== snapshot.id) fail("ROOM_INVALID_RESPONSE");
  return { room, invite_code: parsed.data.invite_code };
}
export async function joinRoom(
  userId: string,
  code: string,
): Promise<TripRoom> {
  if (typeof code !== "string" || code.length > 128) fail("ROOM_INVALID_CODE");
  const normalized = code.replace(/[\s-]/g, "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) fail("ROOM_INVALID_CODE");
  return checkedRoom(
    await rpc(userId, "join_trip_room", { p_invite_code: normalized }),
    userId,
  );
}
export async function publishRoom(
  userId: string,
  roomId: string,
  trip: Trip,
  expectedRevision: number,
): Promise<TripRoom> {
  const snapshot = checkedTrip(trip, "ROOM_INVALID_TRIP");
  const room = checkedOwnerRoom(
    await rpc(userId, "publish_trip_room", {
      p_room_id: validId(roomId),
      p_trip: snapshot,
      p_expected_revision: validRevision(expectedRevision),
    }),
    userId,
    roomId,
  );
  if (room.trip.id !== snapshot.id) fail("ROOM_INVALID_RESPONSE");
  return room;
}
export async function linkRoomPerson(
  userId: string,
  roomId: string,
  personId: string,
  targetUserId: string | null,
  expectedRevision: number,
): Promise<TripRoom> {
  if (!z.string().min(1).max(100).safeParse(personId).success)
    fail("ROOM_INVALID_TRIP");
  return checkedOwnerRoom(
    await rpc(userId, "link_trip_room_person", {
      p_room_id: validId(roomId),
      p_person_id: personId,
      p_user_id: targetUserId === null ? null : validId(targetUserId),
      p_expected_revision: validRevision(expectedRevision),
    }),
    userId,
    roomId,
  );
}
export async function rotateRoomInvite(
  userId: string,
  roomId: string,
): Promise<{ invite_code: string }> {
  const parsed = inviteSchema.safeParse(
    await rpc(userId, "rotate_trip_room_invite", {
      p_room_id: validId(roomId),
    }),
  );
  if (!parsed.success) fail("ROOM_INVALID_RESPONSE");
  return parsed.data;
}
export async function leaveRoom(userId: string, roomId: string): Promise<void> {
  await rpc(userId, "leave_trip_room", { p_room_id: validId(roomId) });
}
export async function removeRoomMember(
  userId: string,
  roomId: string,
  targetUserId: string,
): Promise<TripRoom> {
  return checkedOwnerRoom(
    await rpc(userId, "remove_trip_room_member", {
      p_room_id: validId(roomId),
      p_user_id: validId(targetUserId),
    }),
    userId,
    roomId,
  );
}
export async function deleteRoom(
  userId: string,
  roomId: string,
): Promise<void> {
  await rpc(userId, "delete_trip_room", { p_room_id: validId(roomId) });
}
