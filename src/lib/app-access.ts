import { getCloudClient } from "./cloud-client";

/** Verify the session with Supabase before mounting the local workspace. */
export async function confirmAppUser(token: string, userId: string) {
  const client = getCloudClient();
  if (!client) throw new Error("Вход в приложение пока не настроен.");
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user || data.user.id !== userId)
    throw new Error("Не удалось подтвердить вход. Войдите ещё раз.");
}
