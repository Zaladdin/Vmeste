import { beforeEach, describe, expect, it, vi } from "vitest";
import { sampleTrip } from "./model";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
  header: vi.fn(),
}));
vi.mock("./cloud-client", () => ({ getCloudClient: mocks.client }));
import {
  createRoom,
  deleteRoom,
  joinRoom,
  leaveRoom,
  linkRoomPerson,
  listRooms,
  publishRoom,
  readRoom,
  removeRoomMember,
  roomCapabilities,
  rotateRoomInvite,
} from "./room-client";

const owner = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const code = "a".repeat(32);
const stamp = "2026-10-28T12:00:00Z";
function room() {
  return {
    id: roomId,
    owner_id: owner,
    trip: structuredClone(sampleTrip),
    revision: 1,
    updated_at: stamp,
    members: [
      { user_id: owner, joined_at: stamp },
      { user_id: member, joined_at: stamp },
    ],
    links: [] as { person_id: string; user_id: string }[],
  };
}
function respond(data: unknown, error: unknown = null) {
  mocks.header.mockResolvedValue({ data, error });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({
    data: { session: { access_token: "verified-owner-token" } },
    error: null,
  });
  mocks.getUser.mockResolvedValue({
    data: { user: { id: owner } },
    error: null,
  });
  mocks.rpc.mockReturnValue({ setHeader: mocks.header });
  mocks.client.mockReturnValue({
    auth: { getSession: mocks.getSession, getUser: mocks.getUser },
    rpc: mocks.rpc,
  });
  respond(room());
});

describe("authenticated room client", () => {
  it("verifies identity and pins every RPC to the verified bearer token", async () => {
    expect(await readRoom(owner, roomId)).toEqual(room());
    expect(mocks.getUser).toHaveBeenCalledWith("verified-owner-token");
    expect(mocks.header).toHaveBeenCalledWith(
      "Authorization",
      "Bearer verified-owner-token",
    );
    expect(mocks.rpc).toHaveBeenCalledWith("read_trip_room", {
      p_room_id: roomId,
    });
  });
  it("does not call RPC for a changed account", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: member } },
      error: null,
    });
    await expect(createRoom(owner, sampleTrip)).rejects.toThrow(/аккаунт/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects missing or rejected authentication without an RPC", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    await expect(listRooms(owner)).rejects.toThrow(/аккаунт/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("creates only a validated trip snapshot and requires the returned owner", async () => {
    respond({ room: room(), invite_code: code });
    expect((await createRoom(owner, sampleTrip)).invite_code).toBe(code);
    expect(mocks.rpc).toHaveBeenCalledWith("create_trip_room", {
      p_trip: sampleTrip,
    });
    respond({ room: { ...room(), owner_id: member }, invite_code: code });
    await expect(createRoom(owner, sampleTrip)).rejects.toThrow(/ответ/);
  });
  it("never sends original file data or extra fields as a shared plan", async () => {
    await expect(
      createRoom(owner, {
        ...sampleTrip,
        documents: [{ blob: "private" }],
      } as typeof sampleTrip),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("normalizes a formatted invitation and rejects invalid codes before sending", async () => {
    await joinRoom(owner, "AAAA AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    expect(mocks.rpc).toHaveBeenCalledWith("join_trip_room", {
      p_invite_code: code,
    });
    mocks.rpc.mockClear();
    await expect(joinRoom(owner, "1234")).rejects.toThrow(/код/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects room responses that omit the caller or owner membership", async () => {
    respond({ ...room(), members: [{ user_id: member, joined_at: stamp }] });
    await expect(readRoom(owner, roomId)).rejects.toThrow(/ответ/);
    respond({ ...room(), owner_id: "44444444-4444-4444-8444-444444444444" });
    await expect(readRoom(owner, roomId)).rejects.toThrow(/ответ/);
  });
  it("rejects another room and malformed, duplicate or dangling people links", async () => {
    respond({ ...room(), id: crypto.randomUUID() });
    await expect(readRoom(owner, roomId)).rejects.toThrow(/ответ/);
    for (const links of [
      [{ person_id: "missing", user_id: owner }],
      [{ person_id: sampleTrip.members[0].id, user_id: crypto.randomUUID() }],
      [
        { person_id: sampleTrip.members[0].id, user_id: owner },
        { person_id: sampleTrip.members[0].id, user_id: member },
      ],
      [
        { person_id: sampleTrip.members[0].id, user_id: owner },
        { person_id: sampleTrip.members[1].id, user_id: owner },
      ],
    ]) {
      respond({ ...room(), links });
      await expect(readRoom(owner, roomId)).rejects.toThrow(/ответ/);
    }
  });
  it("checks capability and rejects an unknown backend version", async () => {
    respond({ version: 1 });
    expect(await roomCapabilities(owner)).toBe(true);
    respond({ version: 2 });
    await expect(roomCapabilities(owner)).rejects.toThrow(/подключены/);
  });
  it("validates summaries and duplicate room IDs", async () => {
    const summary = {
      id: roomId,
      owner_id: owner,
      title: "Trip room",
      revision: 1,
      updated_at: stamp,
    };
    respond([summary]);
    expect(await listRooms(owner)).toEqual([summary]);
    respond([summary, summary]);
    await expect(listRooms(owner)).rejects.toThrow(/ответ/);
  });
  it("passes revision and explicit member identity for owner publication and linking", async () => {
    await publishRoom(owner, roomId, sampleTrip, 3);
    expect(mocks.rpc).toHaveBeenLastCalledWith("publish_trip_room", {
      p_room_id: roomId,
      p_trip: sampleTrip,
      p_expected_revision: 3,
    });
    await linkRoomPerson(owner, roomId, sampleTrip.members[0].id, member, 4);
    expect(mocks.rpc).toHaveBeenLastCalledWith("link_trip_room_person", {
      p_room_id: roomId,
      p_person_id: sampleTrip.members[0].id,
      p_user_id: member,
      p_expected_revision: 4,
    });
    await linkRoomPerson(owner, roomId, sampleTrip.members[0].id, null, 5);
    expect(mocks.rpc).toHaveBeenLastCalledWith("link_trip_room_person", {
      p_room_id: roomId,
      p_person_id: sampleTrip.members[0].id,
      p_user_id: null,
      p_expected_revision: 5,
    });
  });
  it("never exposes raw SQL or SDK errors", async () => {
    respond(null, { code: "P0001", message: "ROOM_CONFLICT" });
    await expect(readRoom(owner, roomId)).rejects.toThrow(/изменилась/);
    respond(null, { code: "XX000", message: "password=private SQL internals" });
    await expect(readRoom(owner, roomId)).rejects.toThrow(
      /^Не удалось связаться/,
    );
    respond(null, { code: "PGRST202", message: "secret schema detail" });
    await expect(roomCapabilities(owner)).rejects.toThrow(
      /Комнаты ещё не подключены/,
    );
  });
  it("maps removed access to a stable safe error code", async () => {
    respond(null, { code: "P0001", message: "ROOM_FORBIDDEN" });
    await expect(readRoom(owner, roomId)).rejects.toMatchObject({
      code: "ROOM_FORBIDDEN",
    });
  });
  it("uses the bounded RPCs for invitations and membership removal", async () => {
    respond({ invite_code: code });
    expect(await rotateRoomInvite(owner, roomId)).toEqual({
      invite_code: code,
    });
    respond(room());
    await removeRoomMember(owner, roomId, member);
    expect(mocks.rpc).toHaveBeenLastCalledWith("remove_trip_room_member", {
      p_room_id: roomId,
      p_user_id: member,
    });
    respond(null);
    await leaveRoom(owner, roomId);
    expect(mocks.rpc).toHaveBeenLastCalledWith("leave_trip_room", {
      p_room_id: roomId,
    });
    await deleteRoom(owner, roomId);
    expect(mocks.rpc).toHaveBeenLastCalledWith("delete_trip_room", {
      p_room_id: roomId,
    });
  });
});
