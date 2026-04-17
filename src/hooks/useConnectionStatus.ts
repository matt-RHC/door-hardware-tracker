"use client"

import { useState, useEffect, useCallback, useRef } from "react"

const PING_INTERVAL_MS = 30_000

interface ConnectionStatus {
  isOnline: boolean
  lastCheckedAt: Date | null
  isChecking: boolean
}

export function useConnectionStatus(): ConnectionStatus {
  const [isOnline, setIsOnline] = useState(true)
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const lastPingRef = useRef<number>(0)

  const ping = useCallback(async () => {
    const now = Date.now()
    if (now - lastPingRef.current < PING_INTERVAL_MS) return
    lastPingRef.current = now

    setIsChecking(true)
    try {
      const res = await fetch("/api/health", {
        method: "GET",
        cache: "no-store",
      })
      if (res.ok) {
        setIsOnline(true)
        setLastCheckedAt(new Date())
      } else {
        setIsOnline(navigator.onLine)
      }
    } catch {
      setIsOnline(navigator.onLine)
    } finally {
      setIsChecking(false)
    }
  }, [])

  useEffect(() => {
    // Initial check
    ping()

    const interval = setInterval(ping, PING_INTERVAL_MS)

    const handleOnline = () => {
      ping()
    }
    const handleOffline = () => {
      setIsOnline(false)
      setLastCheckedAt(new Date())
    }

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    return () => {
      clearInterval(interval)
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [ping])

  return { isOnline, lastCheckedAt, isChecking }
}
