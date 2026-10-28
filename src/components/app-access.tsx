"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Luggage } from "lucide-react";
import { confirmAppUser } from "@/lib/app-access";
import { CloudAccount, useCloudAccount } from "./cloud-account";
import { AccountStorageProvider } from "./account-storage";

export function AppAccess({ children }: { children: ReactNode }) {
  const account = useCloudAccount();
  const token = account.session?.access_token;
  const userId = account.session?.user.id;
  const [verified, setVerified] = useState<{
    token: string;
    userId: string;
  } | null>(null);
  const [failure, setFailure] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setVerified(null);
    setFailure("");
    if (token && userId)
      void confirmAppUser(token, userId).then(
        () => {
          if (active) setVerified({ token, userId });
        },
        () => {
          if (active)
            setFailure(
              "Не удалось подтвердить вход. Проверьте интернет и повторите проверку или войдите ещё раз.",
            );
        },
      );
    return () => {
      active = false;
    };
  }, [token, userId, retry]);

  if (
    !account.loading &&
    token &&
    userId &&
    verified?.token === token &&
    verified.userId === userId
  )
    return (
      <AccountStorageProvider key={userId} userId={userId}>
        {children}
      </AccountStorageProvider>
    );

  const checking = account.loading || Boolean(token && !failure);
  return (
    <main className="app-access">
      <div className="app-access-card">
        <span className="app-access-brand">
          <Luggage size={27} aria-hidden="true" /> Вместе
        </span>
        <h1>Ваши поездки начинаются здесь</h1>
        <p>
          Войдите или создайте аккаунт, чтобы добавлять билеты, бронирования и
          документы в план поездки.
        </p>
        {checking ? (
          <p role="status">Проверяем вход…</p>
        ) : (
          <>
            <CloudAccount account={account} disabled={false} purpose="app" />
            {failure ? (
              <div role="alert">
                <p>{failure}</p>
                <button
                  className="button secondary"
                  onClick={() => {
                    setFailure("");
                    setVerified(null);
                    setRetry((value) => value + 1);
                  }}
                >
                  Повторить проверку
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
