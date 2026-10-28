"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createAccountStorage, type AccountStorage } from "@/lib/storage";

const StorageContext = createContext<AccountStorage | null>(null);

export function AccountStorageProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const storage = useMemo(() => createAccountStorage(userId), [userId]);
  return (
    <StorageContext.Provider value={storage}>
      {children}
    </StorageContext.Provider>
  );
}

export function useAccountStorage() {
  const storage = useContext(StorageContext);
  if (!storage) throw new Error("Для открытия поездок нужно войти в аккаунт.");
  return storage;
}
