import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { RecognitionError } from "./recognition-common";

const limitSchema = z.number().int().min(0).max(100);
const stateSchema = z
  .object({
    version: z.literal(1),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((day) => {
        const date = new Date(`${day}T00:00:00.000Z`);
        return (
          Number.isFinite(date.getTime()) &&
          date.toISOString().slice(0, 10) === day
        );
      }),
    used: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limit: limitSchema,
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const unavailable = () =>
  new RecognitionError(
    "Не удалось проверить дневной лимит. Распознавание остановлено; сохранение документов доступно.",
    503,
  );

export function createRecognitionBudgetStore(
  root: string,
  now: () => Date = () => new Date(),
) {
  const filename = path.join(root, "recognition-budget.json");
  const lockfile = path.join(root, "recognition-budget.lock");
  let queue: Promise<unknown> = Promise.resolve();
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    const execute = async () => {
      await mkdir(root, { recursive: true });
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            lock = await open(lockfile, "wx", 0o600);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await delay(20);
          }
        }
        if (!lock)
          throw new RecognitionError(
            "Не удалось получить блокировку дневного лимита. Повторите проверку. Если ошибка сохраняется после перезапуска, используйте инструкцию восстановления в README проекта.",
            503,
          );
        return await action();
      } catch (error) {
        if (error instanceof RecognitionError) throw error;
        throw unavailable();
      } finally {
        if (lock) {
          await lock.close();
          await rm(lockfile, { force: true });
        }
      }
    };
    const current = queue.then(execute, execute);
    queue = current.catch(() => undefined);
    return current;
  }
  async function save(state: State) {
    const temporary = path.join(
      root,
      `recognition-budget-${crypto.randomUUID()}.tmp`,
    );
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function load(): Promise<State> {
    const today = now().toISOString().slice(0, 10);
    let state: State;
    try {
      if ((await stat(filename)).size > 4096) throw unavailable();
      state = stateSchema.parse(JSON.parse(await readFile(filename, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const configured = process.env.VMESTE_DAILY_RECOGNITION_LIMIT;
      const limit = configured === undefined ? 10 : Number(configured);
      if (configured !== undefined && !/^\d{1,3}$/.test(configured))
        throw unavailable();
      state = {
        version: 1,
        day: today,
        used: 0,
        limit: limitSchema.parse(limit),
      };
      await save(state);
    }
    if (state.day > today) throw unavailable();
    if (state.day < today) {
      state = { ...state, day: today, used: 0 };
      await save(state);
    }
    return state;
  }
  function status(state: State) {
    const reset = new Date(`${state.day}T00:00:00.000Z`);
    reset.setUTCDate(reset.getUTCDate() + 1);
    return {
      day: state.day,
      limit: state.limit,
      used: state.used,
      remaining: Math.max(0, state.limit - state.used),
      resetAt: reset.toISOString(),
      estimate: { model: "gpt-6.1-sol", credits: 0.65 },
    };
  }
  return {
    get: () => locked(async () => status(await load())),
    setLimit: (limit: number) =>
      locked(async () => {
        if (!limitSchema.safeParse(limit).success)
          throw new RecognitionError("Укажите целое число от 0 до 100", 400);
        const state = { ...(await load()), limit };
        await save(state);
        return status(state);
      }),
    reserve: () =>
      locked(async () => {
        const state = await load();
        if (state.used >= state.limit)
          throw new RecognitionError(
            "Дневной лимит распознавания исчерпан или распознавание приостановлено. Документ сохранён; попробуйте после сброса лимита или измените его в настройках.",
            429,
            Math.max(
              1,
              Math.ceil(
                (Date.parse(status(state).resetAt) - now().getTime()) / 1000,
              ),
            ),
          );
        state.used++;
        await save(state);
        return status(state);
      }),
  };
}
const store = createRecognitionBudgetStore(path.join(process.cwd(), ".local"));
export const getRecognitionBudget = store.get;
export const setRecognitionDailyLimit = store.setLimit;
export const reserveRecognitionAttempt = store.reserve;
