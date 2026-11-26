/**
 * Support tickets for the rider and captain apps.
 *   demo (mock)   : the in-browser store (core/store actions)
 *   live (supabase): public.tickets / public.ticket_messages under RLS — the opener
 *                    sees only their own tickets and never internal notes; the
 *                    database sets opener kind, author kind, safety priority and
 *                    timestamps, so the client only sends content.
 */
import { useCallback, useEffect, useState } from 'react'
import { AUTH_MODE } from '../auth/config'
import { getSupabase } from '../auth/supabaseClient'
import { actions, useEco } from '../core/store'
import type { Ticket, TicketCategory, TicketMessage } from '../core/types'

const LIVE = AUTH_MODE === 'supabase'
type Requester = Ticket['requester']

type DbTicket = { id: string; subject: string; category: TicketCategory; status: Ticket['status']; priority: Ticket['priority']; created_at: string; updated_at: string; ride_id: string | null }
type DbMessage = { ticket_id: string; author_kind: 'rider' | 'driver' | 'agent' | 'system'; body: string; created_at: string }

/** Database rows → the app's Ticket shape (rider → 'customer'). */
export function ticketsFromDb(requester: Requester, rows: DbTicket[], msgs: DbMessage[]): Ticket[] {
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    category: r.category,
    status: r.status,
    priority: r.priority,
    createdAt: Date.parse(r.created_at),
    updatedAt: Date.parse(r.updated_at),
    requester,
    tripId: r.ride_id ?? undefined,
    messages: msgs
      .filter((m) => m.ticket_id === r.id)
      .map((m): TicketMessage => ({ from: m.author_kind === 'rider' ? 'customer' : m.author_kind, text: m.body, at: Date.parse(m.created_at) })),
  }))
}

async function loadMine(requester: Requester): Promise<Ticket[]> {
  const sb = getSupabase()
  const { data: rows, error } = await sb.from('tickets').select('id, subject, category, status, priority, created_at, updated_at, ride_id').eq('opened_by', requester.id).order('created_at', { ascending: false }).limit(100)
  if (error || !rows?.length) return []
  const { data: msgs } = await sb.from('ticket_messages').select('ticket_id, author_kind, body, created_at').in('ticket_id', rows.map((r) => r.id)).order('created_at')
  return ticketsFromDb(requester, rows as DbTicket[], (msgs ?? []) as DbMessage[])
}

/** The signed-in rider's / captain's tickets (live: refreshed every 20 s and after each action). */
export function useMyTickets(requester: Requester): { tickets: Ticket[]; refresh: () => Promise<void> } {
  const local = useEco((s) => s.tickets.filter((x) => x.requester.id === requester.id && x.requester.kind === requester.kind))
  const [live, setLive] = useState<Ticket[]>([])
  const refresh = useCallback(async () => {
    if (LIVE) setLive(await loadMine(requester))
  }, [requester.id, requester.kind]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!LIVE) return
    void refresh()
    const id = window.setInterval(() => void refresh(), 20_000)
    return () => window.clearInterval(id)
  }, [refresh])
  return { tickets: LIVE ? live : local, refresh }
}

export type NewTicket = { requester: Requester; subject: string; category: TicketCategory; text: string; tripId?: string; priority?: Ticket['priority'] }

/** Open a ticket with its first message. Returns an error message on failure (nothing is faked). */
export async function openTicket(t: NewTicket): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!LIVE) {
    actions.createTicket(t)
    return { ok: true }
  }
  const sb = getSupabase()
  const { data, error } = await sb
    .from('tickets')
    .insert({ opened_by: t.requester.id, ride_id: t.tripId ?? null, category: t.category, subject: t.subject.trim().slice(0, 200) })
    .select('id')
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? 'network' }
  const { error: mErr } = await sb.from('ticket_messages').insert({ ticket_id: data.id, author_id: t.requester.id, body: t.text.trim().slice(0, 4000) })
  if (mErr) return { ok: false, error: mErr.message }
  return { ok: true }
}

export async function replyToTicket(ticketId: string, requester: Requester, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!LIVE) {
    actions.replyTicket(ticketId, { from: requester.kind, text })
    return { ok: true }
  }
  const { error } = await getSupabase().from('ticket_messages').insert({ ticket_id: ticketId, author_id: requester.id, body: text.trim().slice(0, 4000) })
  return error ? { ok: false, error: error.message } : { ok: true }
}
