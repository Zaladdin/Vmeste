import { beforeEach, describe, expect, it, vi } from "vitest";
const { getUser, getClient } = vi.hoisted(() => ({
  getUser: vi.fn(),
  getClient: vi.fn(),
}));
vi.mock("./cloud-client", () => ({ getCloudClient: getClient }));
import { confirmAppUser } from "./app-access";
beforeEach(() => {
  vi.resetAllMocks();
  getClient.mockReturnValue({ auth: { getUser } });
});
describe("application access", () => {
  it("verifies the token remotely and accepts the same user", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "owner" } }, error: null });
    await expect(confirmAppUser("token", "owner")).resolves.toBeUndefined();
    expect(getUser).toHaveBeenCalledWith("token");
  });
  it.each([
    { data: { user: null }, error: null },
    { data: { user: { id: "other" } }, error: null },
    { data: { user: { id: "owner" } }, error: new Error("expired") },
  ])("rejects an invalid or mismatched session", async (response) => {
    getUser.mockResolvedValue(response);
    await expect(confirmAppUser("token", "owner")).rejects.toThrow(
      /подтвердить вход/,
    );
  });
  it("does not allow access when verification cannot reach the server", async () => {
    getUser.mockRejectedValue(new Error("offline"));
    await expect(confirmAppUser("token", "owner")).rejects.toThrow();
  });
  it("does not allow access without configured authentication", async () => {
    getClient.mockReturnValue(null);
    await expect(confirmAppUser("token", "owner")).rejects.toThrow(
      /не настроен/,
    );
  });
});
