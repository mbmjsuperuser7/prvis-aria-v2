'use client'
import { sendMessage } from '@/app/actions/chat'
import React, { useState, useRef, useEffect, useCallback } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────────
type Role = 'user' | 'aria'
type Node = 'alpha' | 'gamma' | 'beta' | 'sandbox' | 'system'
type Msg = {
  id: string; role: Role; content: string; ts: number; attachments?: string[]
  node?: Node      // which pipeline node produced this bubble
  streaming?: boolean  // still receiving content
  lines?: string[] // accumulated lines for streaming bubbles
}
type ActivityEvent = { actor: string; event: string; detail: string; ts: string }
type ChatSession = { id: string; title: string; preview: string; ts: number; msgs: Msg[] }
type Props = { customerId: string; healthUrl?: string; mode?: 'widget'|'panel'|'full' }

// ── Design tokens ──────────────────────────────────────────────────────────────
const C = {
  bg:      '#0D0E10',
  panel:   '#111316',
  surface: 'rgba(255,255,255,0.05)',
  surfH:   'rgba(255,255,255,0.08)',
  border:  'rgba(255,255,255,0.09)',
  text:    '#F1F5F9',
  muted:   'rgba(255,255,255,0.38)',
  accent:  '#38BDF8',
  green:   '#86EFAC',
  warn:    '#FBB924',
  error:   '#F87171',
  amber:   '#FB923C',
  alpha:   '#A78BFA',
  beta:    '#38BDF8',
  gamma:   '#86EFAC',
  sandbox: '#FBB924',
  system:  'rgba(255,255,255,0.3)',
}
const HIST_W = 240
const ACT_W  = 300
const STRIP  = 40

function nodeFromActor(actor: string): Node {
  const a = actor.toLowerCase()
  // v2 orchestrator uses Greek symbols — match these first
  if (actor === 'α' || a.includes('alpha')) return 'alpha'
  if (actor === 'β' || a.includes('beta'))  return 'beta'
  if (actor === 'γ' || a.includes('gamma')) return 'gamma'
  if (a.includes('sandbox')) return 'sandbox'
  return 'system'
}
function nodeBadge(node?: Node): string {
  switch(node) {
    case 'alpha':   return 'α'
    case 'gamma':   return 'γ'
    case 'beta':    return 'β'
    case 'sandbox': return 'sb'
    default:        return '—'
  }
}
function nodeColor(node?: Node): string {
  switch(node) {
    case 'alpha':   return C.alpha
    case 'gamma':   return C.gamma
    case 'beta':    return C.beta
    case 'sandbox': return C.sandbox
    default:        return C.system
  }
}
function isActivityOnly(actor: string): boolean {
  // sandbox raw output goes to activity bar only, not chat bubble
  return actor.toLowerCase().includes('sandbox')
}

function actorColor(actor: string): string {
  const a = actor.toLowerCase()
  if (a.includes('alpha'))        return C.alpha
  if (a.includes('beta'))         return C.beta
  if (a.includes('gamma'))        return C.gamma
  if (a.includes('sandbox'))      return C.sandbox
  if (a.includes('orchestrator')) return C.accent
  return C.system
}
function actorPrefix(actor: string): string {
  const a = actor.toLowerCase()
  // v2 orchestrator sends Greek symbols directly
  if (actor === 'α' || a.includes('alpha'))        return 'α'
  if (actor === 'β' || a.includes('beta'))         return 'β'
  if (actor === 'γ' || a.includes('gamma'))        return 'γ'
  if (a.includes('sandbox'))                       return 'sb'
  if (a.includes('orchestrator') || a === 'system') return '·'
  return '·'
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const I = {
  send:        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>,
  plus:        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  hist:        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>,
  act:         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  chevL:       <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>,
  chevR:       <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>,
  x:           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  pencil:      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  trash:       <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>,
  search:      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  paperclip:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>,
  image:       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
  link:        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
  mic:         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>,
  micOff:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v4M8 23h8"/></svg>,
  screenshot:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 10)


function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', second:'2-digit'}) }
  catch { return '' }
}

function groupSessions(sessions: ChatSession[]) {
  const now = Date.now(), d = 86400000
  const b: Record<string, ChatSession[]> = {Today:[], Yesterday:[], 'This week':[], Older:[]}
  sessions.forEach(s => {
    const age = now - s.ts
    if (age < d) b.Today.push(s)
    else if (age < d*2) b.Yesterday.push(s)
    else if (age < d*7) b['This week'].push(s)
    else b.Older.push(s)
  })
  return Object.entries(b).filter(([,v]) => v.length).map(([label,items]) => ({label,items}))
}

const SUGGESTIONS = [
  'What is my current security posture?',
  'Show me critical alerts from the last 24 hours',
  'Which endpoints have failing compliance policies?',
  'What are my top open vulnerabilities?',
  'Generate a security summary for this week',
]

// ── Btn ───────────────────────────────────────────────────────────────────────
function Btn({ onClick, title, active, color, children, disabled, style: ext={} }:
  {onClick?:()=>void; title?:string; active?:boolean; color?:string; children:React.ReactNode; disabled?:boolean; style?:React.CSSProperties}) {
  const [h, setH] = useState(false)
  const col = color || (active ? C.accent : h ? C.text : C.muted)
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)}
      style={{background: active?'rgba(56,189,248,0.1)':h?'rgba(255,255,255,0.05)':'transparent',
        border:`1px solid ${active?'rgba(56,189,248,0.25)':'transparent'}`,
        borderRadius:7, color:col, cursor:disabled?'default':'pointer',
        display:'flex', alignItems:'center', justifyContent:'center',
        padding:'5px 7px', transition:'all 0.12s', opacity:disabled?0.35:1, ...ext}}>
      {children}
    </button>
  )
}

// ── Msg renderer ──────────────────────────────────────────────────────────────
function MsgLines({ lines }: { lines: string[] }) {
  const segments: Array<{type:'code'|'text', lines:string[]}> = []
  let inCode = false
  let cur: {type:'code'|'text', lines:string[]} = {type:'text', lines:[]}
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (!inCode) { if (cur.lines.length) segments.push(cur); cur = {type:'code', lines:[]}; inCode = true }
      else { segments.push(cur); cur = {type:'text', lines:[]}; inCode = false }
    } else { cur.lines.push(line) }
  }
  if (cur.lines.length) segments.push(cur)
  return (
    <div>
      {segments.map((seg, si) => {
        if (seg.type === 'code') return (
          <div key={si} style={{fontFamily:'monospace',fontSize:11,background:'rgba(0,0,0,0.4)',padding:'6px 10px',borderRadius:5,margin:'4px 0',whiteSpace:'pre',overflowX:'auto',lineHeight:1.5}}>
            {seg.lines.join('\n').replace(/^    /gm,'')}
          </div>
        )
        return <div key={si}>{seg.lines.map((line, i) => {
          if (!line.trim()) return <div key={i} style={{height:4}}/>
          if (line.startsWith('### ')) return <div key={i} style={{fontWeight:700,fontSize:13,marginTop:8,marginBottom:2}}>{line.slice(4)}</div>
          if (line.startsWith('## '))  return <div key={i} style={{fontWeight:700,fontSize:14,marginTop:10,marginBottom:3}}>{line.slice(3)}</div>
          if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line))
            return <div key={i} style={{display:'flex',gap:7,marginBottom:2}}>
              <span style={{color:C.accent,flexShrink:0}}>›</span>
              <span>{renderInline(line.replace(/^[-*\d.]+\s/,''))}</span>
            </div>
          if (line.startsWith('  ')) return <div key={i} style={{marginBottom:2,paddingLeft:14,opacity:0.9}}>{renderInline(line.trim())}</div>
          return <div key={i} style={{marginBottom:3}}>{renderInline(line)}</div>
        })}</div>
      })}
    </div>
  )
}

function MsgContent({ content, node, streaming }: { content: string; node?: Node; streaming?: boolean }) {
  const lines = content === '__thinking__' ? [] : content.split('\n')
  return (
    <div>
      {/* Node badge for pipeline bubbles */}
      {node && (
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8,paddingBottom:6,borderBottom:`1px solid rgba(255,255,255,0.07)`}}>
          <span style={{fontSize:10,fontWeight:600,color:nodeColor(node),fontFamily:'monospace',letterSpacing:'0.05em'}}>
            {nodeBadge(node)}
          </span>
          {streaming && <span style={{fontSize:9,color:C.muted,animation:'pulse 1s infinite'}}>●</span>}
        </div>
      )}
      {content === '__thinking__'
        ? <div style={{color:C.muted,fontSize:12}}>Thinking<span style={{animation:'pulse 1s infinite'}}>...</span></div>
        : <MsgLines lines={lines} />
      }
    </div>
  )
}
function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p,i) => {
    if (p.startsWith('**')&&p.endsWith('**')) return <strong key={i}>{p.slice(2,-2)}</strong>
    if (p.startsWith('`')&&p.endsWith('`'))   return <code key={i} style={{fontFamily:'monospace',fontSize:11,background:'rgba(255,255,255,0.1)',padding:'1px 5px',borderRadius:3}}>{p.slice(1,-1)}</code>
    return <span key={i}>{p}</span>
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function AriaChat({ customerId, healthUrl, mode='full' }: Props) {
  const [histOpen,     setHistOpen]     = useState(true)
  const [actOpen,      setActOpen]      = useState(true)
  const [sessions,     setSessions]     = useState<ChatSession[]>([])
  const [activeId,     setActiveId]     = useState(() => uid())
  const [search,       setSearch]       = useState('')
  const [msgs,         setMsgs]         = useState<Msg[]>([])
  const [input,        setInput]        = useState('')
  const [sending,      setSending]      = useState(false)
  const [online,       setOnline]       = useState<boolean|null>(null)
  const [writeMode,    setWriteMode]    = useState(false)
  const [activity,     setActivity]     = useState<ActivityEvent[]>([])
  const [pipelineDone, setPipelineDone] = useState(true)
  // Attach menu
  const [attachMenu,   setAttachMenu]   = useState(false)
  const [uploads,      setUploads]      = useState<string[]>([])
  const [uploading,    setUploading]    = useState(false)
  const [urlPrompt,    setUrlPrompt]    = useState(false)
  const [urlInput,     setUrlInput]     = useState('')
  const [listening,    setListening]    = useState(false)

  const cidRef       = useRef<string>('')  // assigned by server action on first message
  const bottomRef    = useRef<HTMLDivElement>(null)
  const inputRef     = useRef<HTMLTextAreaElement>(null)
  const actBottomRef = useRef<HTMLDivElement>(null)
  const fileRef      = useRef<HTMLInputElement>(null)
  const sseRef       = useRef<EventSource|null>(null)
  const recognRef    = useRef<any>(null)

  // health
  useEffect(() => {
    const check = () => fetch(healthUrl||'/api/health',{cache:'no-store'})
      .then(r=>r.json()).then(d=>setOnline(d.status==='ok'||d.ok!==false)).catch(()=>setOnline(false))
    check()
    const t = setInterval(check, 30000)
    return () => clearInterval(t)
  }, [healthUrl])

  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:'smooth'}) }, [msgs])
  useEffect(() => { actBottomRef.current?.scrollIntoView({behavior:'smooth'}) }, [activity])

  useEffect(() => {
    if (!msgs.length) return
    const first = msgs.find(m=>m.role==='user')
    const title = first?.content.slice(0,52)||'New chat'
    const preview = msgs[msgs.length-1]?.content?.slice(0,80)||''
    setSessions(prev => {
      const ex = prev.find(s=>s.id===activeId)
      if (ex) return prev.map(s=>s.id===activeId?{...s,title,preview,msgs,ts:Date.now()}:s)
      return [{id:activeId,title,preview,msgs,ts:Date.now()},...prev]
    })
  }, [msgs, activeId])

  const sseConnectedCid = useRef<string>('')

  // SSE activity stream — deduplicate by ts+actor+event key
  const seenEvents = useRef<Set<string>>(new Set())

  // Track current node bubble id per node type so we can append to it
  const nodeBubbleIds = useRef<Record<string, string>>({})

  function connectSSE(cid: string) {
    if (sseConnectedCid.current === cid && sseRef.current) return
    if (sseRef.current) sseRef.current.close()
    sseConnectedCid.current = cid
    nodeBubbleIds.current = {}  // reset per pipeline run

    const es = new EventSource(`/api/activity/${cid}`)
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data)
        // Pipeline complete — fetch and render the actual response
        if (ev.event === 'complete') {
          setPipelineDone(true)
          es.close()
          sseConnectedCid.current = ''
          const evTaskId = ev.task_id
          const evActor  = ev.actor
          // Use IIFE to allow async fetch inside non-async onmessage
          ;(async () => {
            try {
              if (evTaskId) {
                const sr = await fetch(`/api/result/${evTaskId}`)
                if (sr.ok) {
                  const result = await sr.json()
                  if (result.response) {
                    setMsgs(prev => {
                      const withoutThinking = prev
                        .filter(m => m.id !== '__thinking__')
                        .map(m => m.streaming ? {...m, streaming: false} : m)
                      return [...withoutThinking, {
                        id: uid(), role: 'aria',
                        content: result.response,
                        ts: Date.now(),
                        node: nodeFromActor(evActor),
                      }]
                    })
                    return
                  }
                }
              }
            } catch {}
            // Fallback — just clean up thinking bubble
            setMsgs(prev => prev
              .filter(m => m.id !== '__thinking__')
              .map(m => m.streaming ? {...m, streaming: false} : m))
          })()
          return
        }

        // Deduplicate
        const key = `${ev.ts}:${ev.actor}:${ev.event}:${ev.detail}`
        if (seenEvents.current.has(key)) return
        seenEvents.current.add(key)

        // Always push to activity bar
        setActivity(prev => [...prev, ev])
        setActOpen(true)

        // Map event to chat bubble
        const node = nodeFromActor(ev.actor)

        // Sandbox raw output → activity bar only, no chat bubble
        if (node === 'sandbox') return

        // Orchestrator start/complete → no chat bubble
        if (ev.actor.toLowerCase().includes('orchestrator')) return

        // Build the line to add to the bubble
        let line = ''
        if (ev.event && ev.detail) line = `**${ev.event}** ${ev.detail}`
        else if (ev.event)         line = `**${ev.event}**`
        else if (ev.detail)        line = ev.detail
        else return

        // Check if we have an existing streaming bubble for this node
        const existingId = nodeBubbleIds.current[node]
        if (existingId) {
          // Append line to existing bubble
          setMsgs(prev => prev.map(m => {
            if (m.id !== existingId) return m
            const newLines = [...(m.lines || []), line]
            return {...m, lines: newLines, content: newLines.join('\n'), streaming: true}
          }))
        } else {
          // Create new bubble for this node
          const bubbleId = uid()
          nodeBubbleIds.current[node] = bubbleId
          const newMsg: Msg = {
            id: bubbleId, role: 'aria',
            content: line, lines: [line],
            ts: Date.now(), node, streaming: true
          }
          // Remove __thinking__ placeholder if it exists, add new bubble
          setMsgs(prev => {
            const withoutThinking = prev.filter(m => m.id !== '__thinking__')
            return [...withoutThinking, newMsg]
          })
        }
      } catch {}
    }
    es.onerror = () => { es.close(); sseConnectedCid.current = '' }
    sseRef.current = es
  }

  // voice
  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { alert('Voice input not supported'); return }
    const rec = new SR()
    rec.continuous = false; rec.interimResults = false; rec.lang = 'en-US'
    rec.onresult = (e: any) => { setInput(e.results[0][0].transcript); setListening(false) }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    rec.start(); recognRef.current = rec; setListening(true); setAttachMenu(false)
  }, [])
  const stopListening = useCallback(() => { recognRef.current?.stop(); setListening(false) }, [])

  // file attach
  const handleFiles = useCallback(async (files: FileList|null) => {
    if (!files?.length) return
    setUploading(true); setAttachMenu(false)
    const names: string[] = []
    for (const f of Array.from(files)) {
      try {
        const fd = new FormData(); fd.append('file', f); fd.append('customer_id', customerId)
        const r = await fetch(`/api/upload`, { method: 'POST', body: fd })
        if (r.ok) names.push(f.name)
        else names.push(f.name) // still show even if backend not wired yet
      } catch { names.push(f.name) }
    }
    setUploads(prev => [...prev, ...names]); setUploading(false)
  }, [customerId])

  // url attach
  const handleUrl = useCallback(async () => {
    if (!urlInput.trim()) return
    setUploads(prev => [...prev, urlInput.trim()])
    setUrlInput(''); setUrlPrompt(false); setAttachMenu(false)
  }, [urlInput])

  // send
  const send = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || sending) return
    setInput(''); setUploads([]); setSending(true); setPipelineDone(false)

    const userMsg: Msg = {id:uid(), role:'user', content:msg, ts:Date.now(),
                          attachments: uploads.length ? [...uploads] : undefined}
    // Add user message + a placeholder that SSE will replace with node bubbles
    setMsgs(prev => [...prev, userMsg,
      {id:'__thinking__', role:'aria', content:'__thinking__', ts:Date.now()+1}])

    try {
      const enqueued = await sendMessage({
        message: msg,
        cid: cidRef.current || undefined,
        persona: writeMode ? 'security_engineer' : undefined,
      })

      if (enqueued.status === 'error' || !enqueued.task_id) {
        throw new Error(enqueued.error || 'Message delivery failed')
      }

      // Store CiD returned by server — all subsequent messages use same CiD
      if (enqueued.cid) cidRef.current = enqueued.cid

      const taskId = enqueued.task_id

      // Connect SSE AFTER we have the real CiD from server — not before
      connectSSE(enqueued.cid)

      // Wait for pipeline to complete (SSE drives the bubbles, we just wait for done signal)
      const deadline = Date.now() + 300_000
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 1500))
        if (pipelineDone) break
        // Fallback: poll status in case SSE missed done event
        try {
          const sr = await fetch(`/api/result/${taskId}`)
          if (sr.ok) {
            const status = await sr.json()
            if (status.status === 'complete' || status.status === 'revised') {
              // SSE may have missed done — render response from poll
              if (status.response) {
                setMsgs(prev => {
                  const withoutThinking = prev
                    .filter(m => m.id !== '__thinking__')
                    .map(m => m.streaming ? {...m, streaming: false} : m)
                  return [...withoutThinking, {
                    id: uid(), role: 'aria',
                    content: status.response,
                    ts: Date.now(),
                  }]
                })
              } else {
                setMsgs(prev => prev
                  .filter(m => m.id !== '__thinking__')
                  .map(m => m.streaming ? {...m, streaming: false} : m))
              }
              setPipelineDone(true)
              break
            }
            if (status.status === 'error') {
              setMsgs(prev => prev
                .filter(m => m.id !== '__thinking__')
                .concat([{id:uid(), role:'aria', content: status.response || 'Something went wrong.', ts:Date.now()}]))
              setPipelineDone(true)
              break
            }
          }
        } catch {}
      }

    } catch(e: any) {
      const errMsg = e?.message?.includes('HTTP') ? `Error: ${e.message}` : 'Connection error. Please try again.'
      setMsgs(prev => prev.filter(m => m.id !== '__thinking__').concat(
        [{id:uid(), role:'aria', content:errMsg, ts:Date.now()}]
      ))
    }

    setSending(false); inputRef.current?.focus()
  }, [input, sending, customerId, writeMode, uploads, pipelineDone])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const newChat = () => {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null }
    sseConnectedCid.current = ''
    seenEvents.current.clear()
    cidRef.current = ''  // reset — server action assigns new CiD on next message
    setActiveId(uid()); setMsgs([]); setUploads([]); setActivity([]); setPipelineDone(true)
    inputRef.current?.focus()
  }

  const filtered = search ? sessions.filter(s=>(s.title+s.preview).toLowerCase().includes(search.toLowerCase())) : sessions
  const groups = groupSessions(filtered)

  // ── History panel ──────────────────────────────────────────────────────────
  const histPanel = (
    <div style={{width:histOpen?HIST_W:STRIP,minWidth:histOpen?HIST_W:STRIP,maxWidth:histOpen?HIST_W:STRIP,
      height:'100%',background:C.panel,borderRight:`1px solid ${C.border}`,
      display:'flex',flexDirection:'column',overflow:'hidden',flexShrink:0,
      transition:'width 0.2s,min-width 0.2s,max-width 0.2s'}}>
      <div style={{padding:'9px 8px',display:'flex',alignItems:'center',gap:4,borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
        {histOpen && <span style={{fontSize:10,fontWeight:700,color:C.text,flex:1,paddingLeft:4,letterSpacing:'0.05em',textTransform:'uppercase'}}>History</span>}
        {histOpen && <Btn onClick={newChat} title="New chat" color={C.accent}>{I.plus}</Btn>}
        <Btn onClick={()=>setHistOpen(v=>!v)} title={histOpen?'Collapse':'Expand'}>
          {histOpen ? I.chevL : I.hist}
        </Btn>
      </div>
      {histOpen ? (
        <>
          <div style={{padding:'6px 8px',borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
            <div style={{display:'flex',alignItems:'center',gap:6,background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:'5px 9px'}}>
              <span style={{color:C.muted,display:'flex'}}>{I.search}</span>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search..."
                style={{background:'transparent',border:'none',outline:'none',fontSize:11,color:C.text,fontFamily:'inherit',flex:1}}/>
              {search && <button onClick={()=>setSearch('')} style={{background:'none',border:'none',color:C.muted,cursor:'pointer',display:'flex',padding:0}}>{I.x}</button>}
            </div>
          </div>
          <div style={{flex:1,overflowY:'auto',padding:'4px 0'}}>
            {groups.length === 0 ? (
              <div style={{padding:'20px 12px',color:C.muted,fontSize:11,textAlign:'center'}}>
                {search ? 'No matches' : 'No chats yet'}
              </div>
            ) : groups.map(g => (
              <div key={g.label}>
                <div style={{padding:'8px 12px 3px',fontSize:9,color:C.muted,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.06em'}}>{g.label}</div>
                {g.items.map(s => (
                  <button key={s.id} onClick={()=>{setActiveId(s.id);setMsgs(s.msgs)}} style={{
                    width:'100%',textAlign:'left',background:s.id===activeId?C.surfH:'transparent',
                    border:'none',borderLeft:`2px solid ${s.id===activeId?C.accent:'transparent'}`,
                    padding:'6px 12px',cursor:'pointer',fontFamily:'inherit',transition:'background 0.1s'}}
                    onMouseEnter={e=>{if(s.id!==activeId)(e.currentTarget as HTMLElement).style.background=C.surface}}
                    onMouseLeave={e=>{if(s.id!==activeId)(e.currentTarget as HTMLElement).style.background='transparent'}}>
                    <div style={{fontSize:12,color:C.text,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{s.title}</div>
                    <div style={{fontSize:10,color:C.muted,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',marginTop:1}}>{s.preview}</div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',paddingTop:10,gap:6}}>
          <Btn onClick={newChat} title="New chat" color={C.accent}>{I.plus}</Btn>
        </div>
      )}
    </div>
  )

  // ── Chat panel ─────────────────────────────────────────────────────────────
  const chatPanel = (
    <div style={{flex:1,display:'flex',flexDirection:'column',height:'100%',minWidth:0,position:'relative'}}>
      {/* Messages */}
      <div style={{flex:1,overflowY:'auto',padding:'20px 24px',display:'flex',flexDirection:'column',gap:14}}>
        {msgs.length === 0 && (
          <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'48px 24px',textAlign:'center'}}>
            <div style={{width:52,height:52,borderRadius:'50%',background:`linear-gradient(135deg,${C.accent},${C.green})`,display:'flex',alignItems:'center',justifyContent:'center',marginBottom:16,boxShadow:`0 0 28px rgba(56,189,248,0.18)`}}>
              <span style={{fontSize:24,color:'#08090A'}}>✦</span>
            </div>
            <div style={{fontSize:17,fontWeight:700,marginBottom:7}}>Ask Aria anything</div>
            <div style={{fontSize:12,color:C.muted,maxWidth:340,marginBottom:24,lineHeight:1.8}}>
              Security posture · Alerts · Vulnerabilities · Compliance — or ask Aria to act in your environment.
            </div>
            <div style={{display:'flex',flexWrap:'wrap',gap:7,justifyContent:'center',maxWidth:540}}>
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={()=>send(s)}
                  onMouseEnter={e=>{const el=e.currentTarget as HTMLElement;el.style.background=C.surfH;el.style.borderColor=C.accent;el.style.color=C.text}}
                  onMouseLeave={e=>{const el=e.currentTarget as HTMLElement;el.style.background=C.surface;el.style.borderColor=C.border;el.style.color=C.muted}}
                  style={{padding:'6px 13px',background:C.surface,border:`1px solid ${C.border}`,borderRadius:18,color:C.muted,fontSize:11,cursor:'pointer',fontFamily:'inherit',transition:'all 0.12s'}}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map(msg => (
          <div key={msg.id} style={{display:'flex',gap:9,
            flexDirection:msg.role==='user'?'row-reverse':'row',
            alignItems:'flex-start'}}>
            {/* Avatar — shows node color for pipeline bubbles */}
            <div style={{width:28,height:28,borderRadius:'50%',flexShrink:0,
              background: msg.node
                ? `linear-gradient(135deg,${nodeColor(msg.node)},${nodeColor(msg.node)}88)`
                : msg.role==='aria'
                  ? `linear-gradient(135deg,${C.accent},${C.green})`
                  : C.surface,
              display:'flex',alignItems:'center',justifyContent:'center'}}>
              <span style={{fontSize:10,color:'#08090A',fontWeight:700,fontFamily:'monospace'}}>
                {msg.node==='alpha' ? 'α'
                  : msg.node==='gamma' ? 'γ'
                  : msg.node==='beta'  ? 'β'
                  : msg.role==='aria'  ? '✦'
                  : '↑'}
              </span>
            </div>
            <div style={{maxWidth:'78%'}}>
              {msg.attachments?.length ? (
                <div style={{marginBottom:5,display:'flex',flexWrap:'wrap',gap:4}}>
                  {msg.attachments.map(f=><span key={f} style={{fontSize:10,padding:'2px 8px',
                    background:'rgba(56,189,248,0.08)',border:'1px solid rgba(56,189,248,0.2)',
                    borderRadius:4,color:C.accent}}>⊞ {f}</span>)}
                </div>
              ) : null}
              {msg.content === '__thinking__' ? (
                <div style={{background:C.surface,borderRadius:10,padding:'10px 14px',display:'flex',gap:5,alignItems:'center'}}>
                  {[0,1,2].map(j=><span key={j} style={{width:6,height:6,borderRadius:'50%',
                    background:C.accent,display:'inline-block',opacity:0.7}}/>)}
                  <span style={{fontSize:11,color:C.muted,marginLeft:4}}>Pipeline starting...</span>
                </div>
              ) : (
                <div style={{
                  background: msg.node
                    ? `linear-gradient(135deg,${nodeColor(msg.node)}0A,${nodeColor(msg.node)}05)`
                    : msg.role==='user' ? C.accent : C.surface,
                  border: msg.node ? `1px solid ${nodeColor(msg.node)}22` : 'none',
                  color: msg.role==='user'?'#08090A':C.text,
                  borderRadius: msg.role==='user'?'13px 13px 3px 13px':'13px 13px 13px 3px',
                  padding:'10px 14px',fontSize:13,lineHeight:1.65}}>
                  <MsgContent content={msg.content} node={msg.node} streaming={msg.streaming}/>
                </div>
              )}
              <div style={{fontSize:9,color:'rgba(255,255,255,0.18)',marginTop:2,paddingLeft:2,display:'flex',gap:8}}>
                <span>{new Date(msg.ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span>
                {msg.streaming && <span style={{color:nodeColor(msg.node),opacity:0.7}}>● streaming</span>}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef}/>
      </div>

      {/* Write mode banner */}
      {writeMode && (
        <div style={{padding:'6px 18px',background:'rgba(251,185,36,0.05)',borderTop:`1px solid rgba(251,185,36,0.1)`,display:'flex',gap:8,alignItems:'center',flexShrink:0}}>
          <span style={{color:C.warn,fontSize:11}}>⚠</span>
          <span style={{fontSize:11,color:'rgba(251,185,36,0.75)',flex:1}}><strong>Write mode active.</strong> Aria can make changes to your environment.</span>
          <button onClick={()=>setWriteMode(false)} style={{background:'none',border:'1px solid rgba(251,185,36,0.25)',borderRadius:5,color:C.warn,fontSize:10,cursor:'pointer',padding:'2px 7px',fontFamily:'inherit'}}>Disable</button>
        </div>
      )}

      {/* Pending uploads */}
      {uploads.length > 0 && (
        <div style={{padding:'5px 16px',display:'flex',gap:6,flexWrap:'wrap',borderTop:`1px solid ${C.border}`,flexShrink:0}}>
          {uploads.map(f=>(
            <span key={f} style={{fontSize:11,padding:'2px 8px',background:'rgba(56,189,248,0.08)',border:'1px solid rgba(56,189,248,0.2)',borderRadius:4,color:C.accent,display:'flex',alignItems:'center',gap:4}}>
              ⊞ {f.length > 28 ? f.slice(0,28)+'…' : f}
              <button onClick={()=>setUploads(p=>p.filter(u=>u!==f))} style={{background:'none',border:'none',color:C.muted,cursor:'pointer',display:'flex',padding:0}}>{I.x}</button>
            </span>
          ))}
        </div>
      )}

      {/* URL input prompt */}
      {urlPrompt && (
        <div style={{padding:'8px 16px',borderTop:`1px solid ${C.border}`,display:'flex',gap:8,flexShrink:0,background:C.panel}}>
          <input value={urlInput} onChange={e=>setUrlInput(e.target.value)} placeholder="Enter URL..."
            onKeyDown={e=>{if(e.key==='Enter')handleUrl();if(e.key==='Escape')setUrlPrompt(false)}}
            autoFocus
            style={{flex:1,background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:'7px 11px',fontSize:12,color:C.text,fontFamily:'inherit',outline:'none'}}/>
          <Btn onClick={handleUrl} color={C.accent} style={{padding:'6px 12px',fontSize:11}}>Add</Btn>
          <Btn onClick={()=>setUrlPrompt(false)}>{I.x}</Btn>
        </div>
      )}

      {/* Attach menu popup */}
      {attachMenu && (
        <div style={{position:'absolute',bottom:62,left:14,background:'#1A1D22',border:`1px solid ${C.border}`,borderRadius:12,padding:6,display:'flex',flexDirection:'column',gap:2,zIndex:100,boxShadow:'0 8px 32px rgba(0,0,0,0.5)',minWidth:160}}>
          {[
            {icon:I.paperclip, label:'Attach file',   action:()=>{fileRef.current?.click();setAttachMenu(false)}},
            {icon:I.image,     label:'Attach image',  action:()=>{fileRef.current?.click();setAttachMenu(false)}},
            {icon:I.screenshot,label:'Screenshot',    action:()=>{setAttachMenu(false);alert('Use browser screenshot shortcut then paste')}},
            {icon:I.link,      label:'Add URL',       action:()=>{setUrlPrompt(true);setAttachMenu(false)}},
            {icon:I.mic,       label:'Voice note',    action:()=>{setAttachMenu(false);listening?stopListening():startListening()}},
          ].map(item=>(
            <button key={item.label} onClick={item.action}
              style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',background:'transparent',border:'none',color:C.text,cursor:'pointer',borderRadius:8,fontFamily:'inherit',fontSize:13,textAlign:'left',transition:'background 0.1s'}}
              onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background=C.surfH}
              onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background='transparent'}>
              <span style={{color:C.muted,display:'flex'}}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <input ref={fileRef} type="file" multiple style={{display:'none'}} onChange={e=>handleFiles(e.target.files)}/>
      <div style={{padding:'9px 14px',borderTop:`1px solid ${C.border}`,display:'flex',gap:7,alignItems:'flex-end',flexShrink:0,background:C.panel}}>
        {/* Attach */}
        <Btn onClick={()=>setAttachMenu(v=>!v)} title="Attach" active={attachMenu} disabled={uploading}>
          {uploading ? <span style={{fontSize:12}}>…</span> : I.paperclip}
        </Btn>

        <textarea ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={handleKey}
          placeholder="Ask Aria about your security environment..."
          rows={1}
          style={{flex:1,background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:'8px 11px',fontSize:13,color:C.text,fontFamily:'inherit',resize:'none',outline:'none',lineHeight:1.55,maxHeight:120}}
          onInput={e=>{const el=e.currentTarget;el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px'}}/>

        {/* Write mode */}
        <Btn onClick={()=>setWriteMode(v=>!v)} title={writeMode?'Disable write mode':'Enable write mode'} active={writeMode} color={writeMode?C.warn:undefined}>
          {I.pencil}
        </Btn>

        {/* Voice */}
        <Btn onClick={listening?stopListening:startListening} title={listening?'Stop':'Voice input'} active={listening} color={listening?C.error:undefined}>
          {listening ? I.micOff : I.mic}
        </Btn>

        {/* Send */}
        <button onClick={()=>send()} disabled={sending||!input.trim()} style={{
          width:36,height:36,borderRadius:9,border:'none',background:C.accent,color:'#08090A',
          cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',
          opacity:(sending||!input.trim())?0.35:1,transition:'opacity 0.1s',flexShrink:0}}>
          {I.send}
        </button>
      </div>
    </div>
  )

  // ── Activity panel ─────────────────────────────────────────────────────────
  const actPanel = (
    <div style={{width:actOpen?ACT_W:STRIP,minWidth:actOpen?ACT_W:STRIP,maxWidth:actOpen?ACT_W:STRIP,
      height:'100%',background:C.panel,borderLeft:`1px solid ${C.border}`,
      display:'flex',flexDirection:'column',overflow:'hidden',flexShrink:0,
      transition:'width 0.2s,min-width 0.2s,max-width 0.2s'}}>
      <div style={{padding:'9px 8px',borderBottom:`1px solid ${C.border}`,display:'flex',alignItems:'center',gap:4,flexShrink:0}}>
        <Btn onClick={()=>setActOpen(v=>!v)} title={actOpen?'Collapse':'Activity'} color={!pipelineDone?C.accent:C.muted}>
          {actOpen ? I.chevR : I.act}
        </Btn>
        {actOpen && <>
          <span style={{fontSize:10,fontWeight:700,color:C.text,flex:1,paddingLeft:4,letterSpacing:'0.05em',textTransform:'uppercase'}}>Activity</span>
          {!pipelineDone && <span style={{width:5,height:5,borderRadius:'50%',background:C.accent,display:'inline-block',animation:'pulse 0.9s infinite'}}/>}
          {activity.length>0 && <Btn onClick={()=>setActivity([])} title="Clear" color={C.muted}>{I.trash}</Btn>}
        </>}
      </div>
      {actOpen ? (
        <div style={{flex:1,overflowY:'auto',padding:'6px 8px',fontFamily:'"JetBrains Mono","Fira Code","Consolas",monospace'}}>
          <div style={{display:'flex',gap:10,marginBottom:8,flexWrap:'wrap'}}>
            {[['α Alpha',C.alpha],['β Beta',C.beta],['γ Gamma',C.gamma],['sb Sandbox',C.sandbox]].map(([l,c])=>(
              <span key={l as string} style={{fontSize:9,color:c as string,opacity:0.7}}>{l as string}</span>
            ))}
          </div>
          {activity.length === 0 ? (
            <div style={{color:C.muted,fontSize:10,marginTop:8}}>$ waiting for activity...</div>
          ) : activity.map((ev, i) => {
            const col = actorColor(ev.actor)
            const pfx = actorPrefix(ev.actor)
            const ts  = fmtTime(ev.ts)
            const line = ev.detail ? `${ev.event}: ${ev.detail}` : ev.event
            return (
              <div key={i} style={{fontSize:10,lineHeight:1.75,whiteSpace:'pre-wrap',wordBreak:'break-all'}}>
                <span style={{color:'rgba(255,255,255,0.18)'}}>{ts} </span>
                <span style={{color:col,fontWeight:700}}>{pfx} </span>
                <span style={{color:C.text}}>{line}</span>
              </div>
            )
          })}
          {!pipelineDone && <div style={{fontSize:10,color:C.accent,marginTop:2,animation:'blink 1s step-end infinite'}}>█</div>}
          <div ref={actBottomRef}/>
        </div>
      ) : (
        <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',paddingTop:10,gap:6}}>
          {!pipelineDone && <span style={{width:5,height:5,borderRadius:'50%',background:C.accent,display:'inline-block',animation:'pulse 0.9s infinite'}}/>}
        </div>
      )}
    </div>
  )

  // ── Header ─────────────────────────────────────────────────────────────────
  const header = (
    <div style={{padding:'9px 16px',borderBottom:`1px solid ${C.border}`,background:'rgba(56,189,248,0.02)',display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
      <div style={{width:32,height:32,borderRadius:'50%',background:`linear-gradient(135deg,${C.accent},${C.green})`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
        <span style={{color:'#08090A',fontSize:15}}>✦</span>
      </div>
      <div>
        <div style={{fontSize:14,fontWeight:700,letterSpacing:'-0.01em'}}>Aria</div>
        <div style={{fontSize:10,color:online===null?C.amber:online?C.green:C.error,display:'flex',alignItems:'center',gap:4}}>
          <span style={{width:4,height:4,borderRadius:'50%',background:online===null?C.amber:online?C.green:C.error,display:'inline-block'}}/>
          {online===null?'Checking...' : online?'Online':'Offline'}
        </div>
      </div>
      <div style={{marginLeft:'auto',display:'flex',gap:3,alignItems:'center'}}>
        <span style={{fontSize:10,color:C.muted}}>by prvis</span>
      </div>
    </div>
  )

  return (
    <div style={{width:'100vw',height:'100vh',background:C.bg,fontFamily:"'Inter',-apple-system,BlinkMacSystemFont,sans-serif",color:C.text,display:'flex',flexDirection:'column',overflow:'hidden'}}>
      {header}
      <div style={{flex:1,display:'flex',overflow:'hidden'}}>
        {histPanel}
        {chatPanel}
        {actPanel}
      </div>
      <style>{`
        *{box-sizing:border-box}
        @keyframes pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        ::-webkit-scrollbar{width:3px}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.07);border-radius:2px}
        textarea{transition:height .1s ease}
        input::placeholder,textarea::placeholder{color:rgba(255,255,255,0.25)}
      `}</style>
    </div>
  )
}
