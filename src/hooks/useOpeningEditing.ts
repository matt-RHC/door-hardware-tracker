import { useState, useCallback } from 'react'
import { useToast } from '@/components/ToastProvider'

export interface EditingOpeningState {
  door_number: string
  hw_set: string | null
  location: string | null
  door_type: string | null
  frame_type: string | null
  fire_rating: string | null
  hand: string | null
}

interface OpeningData {
  door_number: string
  hw_set: string | null
  location: string | null
  door_type: string | null
  frame_type: string | null
  fire_rating: string | null
  hand: string | null
  [key: string]: any
}

interface UseOpeningEditingOptions {
  projectId: string
  doorId: string
  opening: OpeningData | null
  fetchOpeningData: () => Promise<void>
}

export function useOpeningEditing({ projectId, doorId, opening, fetchOpeningData }: UseOpeningEditingOptions) {
  const { showToast } = useToast()
  const [editingOpening, setEditingOpening] = useState(false)
  const [editingOpeningData, setEditingOpeningData] = useState<EditingOpeningState | null>(null)
  const [savingOpening, setSavingOpening] = useState(false)

  const startEditOpening = useCallback(() => {
    if (!opening) return
    setEditingOpening(true)
    setEditingOpeningData({
      door_number: opening.door_number,
      hw_set: opening.hw_set,
      location: opening.location,
      door_type: opening.door_type,
      frame_type: opening.frame_type,
      fire_rating: opening.fire_rating,
      hand: opening.hand,
    })
  }, [opening])

  const cancelEditOpening = useCallback(() => {
    setEditingOpening(false)
    setEditingOpeningData(null)
  }, [])

  const saveEditOpening = useCallback(async () => {
    if (!editingOpeningData) return
    setSavingOpening(true)
    try {
      const response = await fetch(
        `/api/projects/${projectId}/openings/${doorId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingOpeningData),
        }
      )

      if (!response.ok) throw new Error('Failed to save opening')
      await fetchOpeningData()
      setEditingOpening(false)
      setEditingOpeningData(null)
    } catch (err) {
      console.error('Error saving opening:', err)
      showToast('error', 'Failed to save opening. Check your connection and try again.')
    } finally {
      setSavingOpening(false)
    }
  }, [editingOpeningData, projectId, doorId, fetchOpeningData, showToast])

  return {
    editingOpening,
    editingOpeningData,
    setEditingOpeningData,
    savingOpening,
    startEditOpening,
    cancelEditOpening,
    saveEditOpening,
  }
}
