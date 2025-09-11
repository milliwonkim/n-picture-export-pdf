import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsPDF } from 'jspdf'
import * as exifr from 'exifr'

type Item = { id: string; file: File; url: string; addedIndex: number }

function App() {
  const [items, setItems] = useState<Item[]>([])
  const [perPage, setPerPage] = useState<number>(4)
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [orderMap, setOrderMap] = useState<Record<string, number>>({})
  const [metaBusy, setMetaBusy] = useState<boolean>(false)
  const addIndexRef = useRef(0)
  type SortMode = 'imported' | 'latest' | 'exif'
  const [sortMode, setSortMode] = useState<SortMode>('imported')
  const [exifTimes, setExifTimes] = useState<Record<string, number>>({})

  const addFiles = useCallback((fileList: FileList | null) => {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    const next: Item[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID?.() || Math.random()}`,
      file,
      url: URL.createObjectURL(file),
      addedIndex: addIndexRef.current++,
    }))
    setItems((prev) => [...prev, ...next])
  }, [])

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    addFiles(e.dataTransfer.files)
  }, [addFiles])

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  const onPick = useCallback(() => inputRef.current?.click(), [])

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files)
    // reset so selecting same files again still triggers change
    e.target.value = ''
  }, [addFiles])

  useEffect(() => {
    return () => {
      // cleanup object URLs
      items.forEach((it) => URL.revokeObjectURL(it.url))
    }
  }, [items])

  const clearAll = useCallback(() => {
    items.forEach((it) => URL.revokeObjectURL(it.url))
    setItems([])
    setOrderMap({})
  }, [items])

  const readImage = (file: File): Promise<{ dataUrl: string; width: number; height: number; mime: string }> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result
        if (typeof result !== 'string') return reject(new Error('Invalid image data'))
        const img = new Image()
        img.onload = () => resolve({ dataUrl: result, width: img.naturalWidth, height: img.naturalHeight, mime: file.type || 'image/jpeg' })
        img.onerror = reject
        img.src = result
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })

  const downscaleIfNeeded = async (
    img: { dataUrl: string; width: number; height: number; mime: string },
    maxDim = 3000,
  ): Promise<{ dataUrl: string; width: number; height: number; mime: string }> => {
    const { width, height } = img
    const maxSide = Math.max(width, height)
    if (maxSide <= maxDim) return img
    const scale = maxDim / maxSide
    const targetW = Math.round(width * scale)
    const targetH = Math.round(height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    const el = new Image()
    el.src = img.dataUrl
    await new Promise((res, rej) => {
      el.onload = () => res(null)
      el.onerror = rej
    })
    ctx.drawImage(el, 0, 0, targetW, targetH)
    const mime = img.mime.startsWith('image/png') ? 'image/png' : (img.mime.startsWith('image/webp') ? 'image/webp' : 'image/jpeg')
    const quality = mime === 'image/jpeg' ? 0.92 : undefined
    const dataUrl = canvas.toDataURL(mime, quality as any)
    return { dataUrl, width: targetW, height: targetH, mime }
  }

  const calcGrid = (n: number) => {
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)
    return { rows, cols }
  }

  // Common ordered list used by preview and export
  const orderedItems = useMemo(() => {
    const assigned = items
      .filter((it) => orderMap[it.id] != null)
      .sort((a, b) => (orderMap[a.id] ?? 0) - (orderMap[b.id] ?? 0))
    const rest = items.filter((it) => orderMap[it.id] == null)
    const unassigned = (() => {
      if (sortMode === 'imported') return [...rest].sort((a, b) => a.addedIndex - b.addedIndex)
      if (sortMode === 'latest') return [...rest].sort((a, b) => b.file.lastModified - a.file.lastModified)
      // exif mode
      return [...rest].sort((a, b) => {
        const ta = exifTimes[a.id] ?? a.file.lastModified
        const tb = exifTimes[b.id] ?? b.file.lastModified
        return tb - ta
      })
    })()
    return [...assigned, ...unassigned]
  }, [items, orderMap, sortMode, exifTimes])

  const exportPdf = useCallback(async () => {
    if (items.length === 0) return
    setBusy(true)
    try {
      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      const pageW = doc.internal.pageSize.getWidth()
      const pageH = doc.internal.pageSize.getHeight()
      const margin = 0 // 페이지 여백 0
      const gap = 0 // 사진 간격 없음

      // determine order: if any manual order set, use it, then remaining by latest
      const ordered = orderedItems

      // read and downscale images first, keep same order
      const prepared = await Promise.all(
        ordered.map(async (it) => {
          const raw = await readImage(it.file)
          const processed = await downscaleIfNeeded(raw)
          return processed
        })
      )

      for (let start = 0; start < prepared.length; start += perPage) {
        const slice = prepared.slice(start, start + perPage)
        const { rows, cols } = calcGrid(slice.length)
        const cellW = (pageW - margin * 2 - gap * (cols - 1)) / cols
        const cellH = (pageH - margin * 2 - gap * (rows - 1)) / rows

        slice.forEach((img, i) => {
          const r = Math.floor(i / cols)
          const c = i % cols
          const x = margin + c * (cellW + gap)
          const y = margin + r * (cellH + gap)

          // cover image into cell (crop if needed) so no visible gaps
          const imgRatio = img.width / img.height
          const cellRatio = cellW / cellH
          let drawW: number, drawH: number
          if (imgRatio < cellRatio) {
            // image narrower than cell -> match height, overflow width
            drawH = cellH
            drawW = cellH * imgRatio
          } else {
            // image wider than cell -> match width, overflow height
            drawW = cellW
            drawH = cellW / imgRatio
          }
          const offsetX = x + (cellW - drawW) / 2
          const offsetY = y + (cellH - drawH) / 2

          const format = img.mime.startsWith('image/png') ? 'PNG' : (img.mime.startsWith('image/webp') ? 'WEBP' : 'JPEG')
          try {
            doc.addImage(img.dataUrl, format as any, offsetX, offsetY, drawW, drawH, undefined, 'FAST')
          } catch (err) {
            try {
              // fallback to JPEG if needed
              doc.addImage(img.dataUrl, 'JPEG' as any, offsetX, offsetY, drawW, drawH, undefined, 'FAST')
            } catch (e2) {
              console.error('이미지 추가 실패:', e2)
            }
          }
        })

        if (start + perPage < prepared.length) doc.addPage()
      }

      doc.save('collage.pdf')
    } catch (e) {
      console.error(e)
      alert('PDF 생성 중 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }, [items, perPage, orderMap, orderedItems])

  // ordering helpers
  const assignedCount = Object.keys(orderMap).length
  const nextOrder = Math.min(assignedCount + 1, perPage)
  const toggleAssign = useCallback((id: string) => {
    setOrderMap((prev) => {
      if (prev[id] != null) {
        // remove and reindex compactly
        const entries = Object.entries(prev)
          .filter(([k]) => k !== id)
          .sort((a, b) => a[1] - b[1])
        const compact: Record<string, number> = {}
        entries.forEach(([k], i) => (compact[k] = i + 1))
        return compact
      } else {
        const count = Object.keys(prev).length
        if (count >= perPage) return prev
        const entries = Object.entries(prev).sort((a, b) => a[1] - b[1])
        const compact: Record<string, number> = {}
        entries.forEach(([k], i) => (compact[k] = i + 1))
        compact[id] = Object.keys(compact).length + 1
        return compact
      }
    })
  }, [perPage])

  const resetManualOrder = useCallback(() => setOrderMap({}), [])
  // Populate EXIF times when needed for sorting
  useEffect(() => {
    if (sortMode !== 'exif') return
    const pending = items.filter((it) => exifTimes[it.id] == null)
    if (pending.length === 0) return
    let cancelled = false
    ;(async () => {
      setMetaBusy(true)
      try {
        const results = await Promise.all(
          pending.map(async (it) => {
            try {
              const meta = await exifr.parse(it.file, { translateValues: false, pick: ['DateTimeOriginal', 'CreateDate'] })
              const dt = (meta?.DateTimeOriginal as Date | undefined) || (meta?.CreateDate as Date | undefined)
              const t = dt ? dt.getTime() : it.file.lastModified
              return [it.id, t] as const
            } catch {
              return [it.id, it.file.lastModified] as const
            }
          })
        )
        if (!cancelled) {
          setExifTimes((prev) => {
            const next = { ...prev }
            results.forEach(([id, t]) => { next[id] = t })
            return next
          })
        }
      } finally {
        if (!cancelled) setMetaBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [sortMode, items, exifTimes])

  // If perPage reduced below assigned count, clamp assignment to perPage
  useEffect(() => {
    const entries = Object.entries(orderMap).sort((a, b) => a[1] - b[1])
    if (entries.length <= perPage) return
    const kept = entries.slice(0, perPage)
    const compact: Record<string, number> = {}
    kept.forEach(([k], i) => (compact[k] = i + 1))
    setOrderMap(compact)
  }, [perPage])

  const draggingClasses = isDragging ? 'ring-2 ring-indigo-500 bg-indigo-50 dark:bg-indigo-950/20' : ''

  const perPageOptions = [1, 2, 3, 4, 6, 8, 9, 12, 16, 20, 25, 36]

  return (
    <div className="app">
      <h1 className="text-2xl md:text-3xl font-bold">이미지 콜라주 PDF</h1>
      <p className="mt-1 text-gray-600 dark:text-gray-300">드래그앤드랍 또는 파일 선택으로 이미지를 추가하세요. 페이지당 이미지 수 기본값은 4 입니다.</p>

      <div
        className={`mt-4 border-2 border-dashed rounded-3xl p-20 md:p-24 min-h-64 md:min-h-80 flex items-center justify-center text-gray-600 dark:text-gray-300 cursor-pointer transition ${draggingClasses}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={onPick}
        role="button"
        aria-label="이미지 드롭존"
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onInputChange}
          style={{ display: 'none' }}
        />
        <span className="text-2xl md:text-3xl">여기로 이미지를 드롭하거나 클릭하여 선택</span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-3">
          <span className="text-lg font-medium">페이지당 이미지 수</span>
          <select
            className="text-xl md:text-2xl px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={perPage}
            onChange={(e) => setPerPage(Number(e.target.value))}
          >
            {perPageOptions.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <span className="text-base px-2 py-1 rounded bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700">다음 번호: {nextOrder} / {perPage}</span>
        <label className="flex items-center gap-3">
          <span className="text-lg font-medium">정렬 기준</span>
          <select
            className="text-lg md:text-xl px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
          >
            <option value="imported">불러온 순서</option>
            <option value="latest">최신순(파일시간)</option>
            <option value="exif">촬영시간(EXIF)</option>
          </select>
        </label>
        <button
          onClick={resetManualOrder}
          className="px-4 py-3 rounded-lg font-semibold border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-800"
        >
          번호 초기화
        </button>
        <button
          onClick={exportPdf}
          disabled={items.length === 0 || busy}
          className="px-6 py-3 rounded-lg font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'PDF 생성 중...' : 'PDF로 내보내기'}
        </button>
        <button
          onClick={clearAll}
          disabled={items.length === 0 || busy}
          className="px-6 py-3 rounded-lg font-semibold border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          초기화
        </button>
      </div>

      {items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-0 mt-4">
          {items.map((it) => {
            const num = orderMap[it.id]
            return (
              <button
                type="button"
                key={it.id}
                onClick={() => toggleAssign(it.id)}
                className="relative overflow-hidden group cursor-pointer"
                aria-label="썸네일"
              >
                <img className="w-full h-48 md:h-56 object-cover block" src={it.url} alt="선택된 이미지" />
                <span
                  className={`absolute top-1 left-1 min-w-8 h-8 px-2 rounded-full text-sm font-bold flex items-center justify-center ${num ? 'bg-indigo-600 text-white' : 'bg-black/50 text-white group-hover:bg-indigo-500'} select-none`}
                >
                  {num ?? '+'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {orderedItems.length > 0 && (
        <section className="mt-6 space-y-4">
          <h2 className="text-lg font-semibold">페이지 미리보기</h2>
          {Array.from({ length: Math.ceil(orderedItems.length / perPage) }, (_, i) => i).map((p) => {
            const slice = orderedItems.slice(p * perPage, (p + 1) * perPage)
            const { rows, cols } = calcGrid(slice.length)
            return (
              <div key={p} className="border rounded-xl overflow-hidden">
                <div
                  className="grid gap-0"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                >
                  {slice.map((it) => (
                    <div key={it.id} className="relative">
                      <img src={it.url} className="block w-full h-40 md:h-48 object-cover" />
                      {orderMap[it.id] != null && (
                        <span className="absolute top-1 left-1 min-w-8 h-8 px-2 rounded-full text-sm font-bold bg-indigo-600 text-white flex items-center justify-center select-none">
                          {orderMap[it.id]}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}

      <footer className="mt-3 text-sm text-gray-500">총 {items.length}장 선택됨</footer>
    </div>
  )
}

export default App
