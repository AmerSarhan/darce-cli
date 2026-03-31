import React, { createContext, useContext, useState, type ReactNode } from 'react'
import type { AppState, DarceConfig } from '../types.js'

type AppStateContextType = {
  state: AppState
  setState: React.Dispatch<React.SetStateAction<AppState>>
}

const AppStateContext = createContext<AppStateContextType | null>(null)

export function useAppState() {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider')
  return ctx
}

type Props = {
  initialState: AppState
  children: ReactNode
}

export function App({ initialState, children }: Props) {
  const [state, setState] = useState<AppState>(initialState)
  return (
    <AppStateContext.Provider value={{ state, setState }}>
      {children}
    </AppStateContext.Provider>
  )
}
