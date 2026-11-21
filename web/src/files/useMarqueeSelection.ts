import {useEffect, useRef, useState, type MouseEvent, type PointerEvent} from 'react'
import {explorerControl, primaryModifier} from './explorerInput'
import type {FileSelection} from './useFileSelection'

interface Drag {
  id: number
  canvas: HTMLElement
  originX: number
  originY: number
  x: number
  y: number
  initial: FileSelection['selected']
  count: number
  mode: 'replace' | 'add' | 'toggle'
  active: boolean
  first: number
  last: number
}

const dragThreshold = 5
const scrollEdge = 32

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(value, high))
}

export function useMarqueeSelection(selection: FileSelection) {
  const selectionRef = useRef(selection)
  const marquee = useRef<HTMLDivElement>(null)
  const gesture = useRef<Drag>(undefined)
  const suppressClick = useRef(false)
  const [dragCount, setDragCount] = useState<number>()
  useEffect(() => { selectionRef.current = selection }, [selection])

  useEffect(() => {
    let frame = 0

    function draw(drag: Drag, scrolling: boolean) {
      const {canvas, originX, originY, x, y} = drag
      const band = marquee.current
      const rect = canvas.getBoundingClientRect()
      const top = Math.max(rect.top, 0)
      const bottom = Math.min(rect.bottom, window.innerHeight)
      const nowX = clamp(x, rect.left, rect.right)
      const nowY = clamp(y, top, bottom)
      const before = canvas.scrollTop
      if (scrolling && nowY < top + scrollEdge) canvas.scrollTop -= top + scrollEdge - nowY
      if (scrolling && nowY > bottom - scrollEdge) canvas.scrollTop += nowY - (bottom - scrollEdge)

      const fromY = rect.top + originY - canvas.scrollTop
      const firstY = Math.min(fromY, nowY)
      const lastY = Math.max(fromY, nowY)
      if (band) {
        band.hidden = false
        band.style.setProperty('--marquee-left', Math.min(originX, nowX) + 'px')
        band.style.setProperty('--marquee-top', Math.max(firstY, top) + 'px')
        band.style.setProperty('--marquee-width', Math.abs(nowX - originX) + 'px')
        band.style.setProperty('--marquee-height', Math.max(0, Math.min(lastY, bottom) - Math.max(firstY, top)) + 'px')
      }

      const rows = canvas.querySelector('tbody')?.rows
      if (rows?.length) {
        const {height, top: firstRowTop} = rows[0].getBoundingClientRect()
        const first = clamp(Math.floor((firstY - firstRowTop) / height), 0, rows.length)
        const last = clamp(Math.ceil((lastY - firstRowTop) / height) - 1, -1, rows.length - 1)
        if (first !== drag.first || last !== drag.last) {
          drag.first = first
          drag.last = last
          selectionRef.current.marquee(drag.initial, first, last, drag.mode)
        }
      }
      const selection = selectionRef.current
      const awaitingPage = nowY > bottom - scrollEdge && selection.entries.length < selection.total
      return canvas.scrollTop !== before || awaitingPage
    }

    function tick() {
      frame = 0
      const drag = gesture.current
      if (drag?.active && draw(drag, true)) frame = requestAnimationFrame(tick)
    }

    function move(event: globalThis.PointerEvent) {
      const drag = gesture.current
      if (!drag || event.pointerId !== drag.id) return
      drag.x = event.clientX
      drag.y = event.clientY
      const travelY = drag.y - (drag.canvas.getBoundingClientRect().top + drag.originY - drag.canvas.scrollTop)
      if (!drag.active && Math.hypot(drag.x - drag.originX, travelY) < dragThreshold) return
      if (!drag.active) {
        drag.active = true
        suppressClick.current = true
        setDragCount(drag.count)
        drag.canvas.focus({preventScroll: true})
        drag.canvas.setPointerCapture(drag.id)
      }
      event.preventDefault()
      if (!frame) frame = requestAnimationFrame(tick)
    }

    function finish(event: globalThis.PointerEvent) {
      const drag = gesture.current
      if (!drag || event.pointerId !== drag.id) return
      gesture.current = undefined
      cancelAnimationFrame(frame)
      frame = 0
      if (!drag.active) return
      if (event.type === 'pointerup') {
        drag.x = event.clientX
        drag.y = event.clientY
        draw(drag, false)
        selectionRef.current.finishMarquee(drag.first <= drag.last ? drag.last : -1)
      } else {
        selectionRef.current.restore(drag.initial)
      }
      if (marquee.current) marquee.current.hidden = true
      setDragCount(undefined)
    }

    window.addEventListener('pointermove', move, {passive: false})
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [])

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    suppressClick.current = false
    const {target, currentTarget: canvas} = event
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch' ||
      !(target instanceof Element) || !canvas.contains(target) || explorerControl(target) || target.closest('thead')) return
    const rect = canvas.getBoundingClientRect()
    if (event.clientX >= rect.left + canvas.clientWidth) return
    gesture.current = {id: event.pointerId, canvas, originX: event.clientX,
      originY: event.clientY - rect.top + canvas.scrollTop, x: event.clientX, y: event.clientY,
      initial: selection.selected, count: selection.count, mode: primaryModifier(event) ? 'toggle' : event.shiftKey ? 'add' : 'replace',
      active: false, first: -1, last: -1}
  }

  function onClickCapture(event: MouseEvent) {
    if (!suppressClick.current || !event.detail) return
    event.preventDefault()
    event.stopPropagation()
  }

  return {marquee, dragCount, onPointerDown, onClickCapture, isSuppressingClick: () => suppressClick.current}
}
