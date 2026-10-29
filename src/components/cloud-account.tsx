"use client";
import { useEffect, useId, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { CLOUD_CONFIGURED, getCloudClient } from "@/lib/cloud-client";
import { CopyValue } from "./copy-value";

export function useCloudAccount() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(CLOUD_CONFIGURED);
  const [error, setError] = useState("");
  useEffect(() => {
    const sdk = getCloudClient();
    if (!sdk) return;
    let active = true,
      version = 0;
    const {
      data: { subscription },
    } = sdk.auth.onAuthStateChange((_event, current) => {
      version++;
      if (active) {
        setSession(current);
        setLoading(false);
        setError("");
      }
    });
    sdk.auth
      .getSession()
      .then(({ data, error: failure }) => {
        if (!active || version) return;
        setSession(data.session);
        setLoading(false);
        if (failure) setError("Не удалось восстановить вход. Войдите ещё раз.");
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError(
            "Не удалось проверить вход. Проверьте подключение к интернету.",
          );
        }
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);
  return { session, loading, error, configured: CLOUD_CONFIGURED };
}

export function CloudAccount({
  account,
  disabled,
  purpose = "recognition",
  compact = false,
}: {
  account: ReturnType<typeof useCloudAccount>;
  disabled: boolean;
  purpose?: "app" | "recognition";
  compact?: boolean;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const help = useId();
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const sdk = getCloudClient();
    if (!sdk || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response =
        mode === "signin"
          ? await sdk.auth.signInWithPassword({ email: email.trim(), password })
          : await sdk.auth.signUp({
              email: email.trim(),
              password,
              options: {
                emailRedirectTo: new URL(location.pathname, location.origin)
                  .href,
              },
            });
      if (response.error) {
        const code = response.error.code;
        throw new Error(
          code === "email_not_confirmed"
            ? "Подтвердите адрес по письму, затем войдите."
            : code === "invalid_credentials"
              ? "Проверьте адрес и пароль."
              : code === "weak_password"
                ? "Используйте более длинный пароль."
                : code === "over_email_send_rate_limit"
                  ? "Сервис регистрации исчерпал лимит писем подтверждения. Повторные нажатия не помогут: сообщите организатору или попробуйте позже."
                  : code === "email_address_not_authorized"
                    ? "Отправка подтверждения на этот адрес пока недоступна. Сообщите организатору, чтобы он подключил отправку почты."
                    : code === "over_request_rate_limit"
                      ? "Слишком много попыток входа или регистрации. Подождите немного и попробуйте снова."
                      : "Не удалось выполнить вход. Проверьте данные и настройки подключения.",
        );
      }
      setPassword("");
      if (mode === "signup" && !response.data.session)
        setNotice(
          "Проверьте почту: подтвердите адрес по ссылке из письма, затем войдите здесь.",
        );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Не удалось войти. Попробуйте ещё раз.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    const sdk = getCloudClient();
    if (!sdk || busy) return;
    setBusy(true);
    setError("");
    try {
      const { error: failure } = await sdk.auth.signOut({ scope: "local" });
      if (failure) throw new Error("Не удалось выйти. Попробуйте ещё раз.");
      setNotice("");
      setPassword("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Не удалось выйти.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (compact)
    return (
      <section className="account-toolbar" aria-label="Ваш аккаунт">
        <span>{account.session?.user.email ?? "Ваш аккаунт"}</span>
        {account.session ? (
          <CopyValue label="Мой ID" value={account.session.user.id} />
        ) : null}
        <button
          className="button secondary"
          disabled={disabled || busy || !account.session}
          onClick={() => void signOut()}
        >
          Выйти
        </button>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  if (!account.configured)
    return (
      <p className="muted cloud-setup-note">
        Вход в приложение пока не настроен. Попробуйте позже.
      </p>
    );
  return (
    <section
      className="cloud-account"
      aria-label={
        purpose === "app" ? "Вход в приложение" : "Облачное распознавание"
      }
    >
      {purpose === "app" ? (
        <h2>Вход в приложение</h2>
      ) : (
        <h3>Облачное распознавание</h3>
      )}
      <p id={help}>
        {purpose === "app" ? (
          "Используйте свою электронную почту и пароль. Поездки и документы сохраняются отдельно для вашего аккаунта в браузере этого устройства."
        ) : (
          <>
            Войдите в один аккаунт здесь и в обработчике. Загруженный для
            распознавания документ сохраняется в закрытом облачном хранилище.
            Обработчик может работать на вашем компьютере или сервере. Пока он
            недоступен, задание ждёт. Поездки между устройствами пока не
            синхронизируются.
          </>
        )}
      </p>
      {account.loading ? (
        <p role="status">Проверяем вход…</p>
      ) : account.session ? (
        <div className="cloud-account-signed-in">
          <span>Вход: {account.session.user.email ?? "ваш аккаунт"}</span>
          <button
            className="button secondary"
            disabled={disabled || busy}
            onClick={() => void signOut()}
          >
            Выйти
          </button>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)} aria-describedby={help}>
          <label>
            Электронная почта
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              maxLength={254}
              disabled={disabled || busy}
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              required
              minLength={mode === "signup" ? 8 : 1}
              maxLength={128}
              disabled={disabled || busy}
            />
          </label>
          <button className="button primary" disabled={disabled || busy}>
            {busy
              ? "Подождите…"
              : mode === "signin"
                ? "Войти"
                : "Создать аккаунт"}
          </button>
          <button
            className="text-button"
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError("");
              setNotice("");
            }}
          >
            {mode === "signin"
              ? "Нет аккаунта? Зарегистрироваться"
              : "Уже есть аккаунт? Войти"}
          </button>
        </form>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error || account.error ? (
        <p className="form-error" role="alert">
          {error || account.error}
        </p>
      ) : null}
    </section>
  );
}
