import { useEffect, useRef, useState } from "react"
import { Button } from "./ui/button"

type AudioStatus = "idle" | "recording" | "processing" | "unsupported"

type AudioConfig = {
  audioCaptureEnabled?: boolean
  apiProvider?: "openai" | "gemini" | "anthropic"
}

export function AudioInterviewPanel() {
  const [status, setStatus] = useState<AudioStatus>("idle")
  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState<string>("openai")
  const [transcript, setTranscript] = useState("")
  const [answer, setAnswer] = useState("")
  const [error, setError] = useState("")
  const [progressMessage, setProgressMessage] = useState("")
  const [progressValue, setProgressValue] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const captureStreamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const statusRef = useRef<AudioStatus>("idle")
  const enabledRef = useRef(false)
  const providerRef = useRef("openai")

  const platform = window.electronAPI.getPlatform()
  const isSupported = platform === "win32"

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    providerRef.current = provider
  }, [provider])

  useEffect(() => {
    let cancelled = false

    const loadConfig = async () => {
      try {
        const config = (await window.electronAPI.getConfig()) as AudioConfig
        if (cancelled) {
          return
        }

        setEnabled(!!config.audioCaptureEnabled)
        setProvider(config.apiProvider || "openai")
        if (!isSupported) {
          setStatus("unsupported")
        }
      } catch (nextError) {
        console.error("Failed to load audio capture config:", nextError)
      }
    }

    loadConfig()

    return () => {
      cancelled = true
      stopTracks()
    }
  }, [isSupported])

  useEffect(() => {
    const cleanup = [
      window.electronAPI.onConfigUpdated((config: AudioConfig) => {
        setEnabled(!!config.audioCaptureEnabled)
        setProvider(config.apiProvider || "openai")
      }),
      window.electronAPI.onAudioToggleRequest(() => {
        void toggleRecording()
      }),
      window.electronAPI.onAudioProcessingStatus((data) => {
        setProgressMessage(data.message)
        setProgressValue(data.progress)
      }),
      window.electronAPI.onAudioTranscriptReady((nextTranscript) => {
        setTranscript(nextTranscript)
      }),
      window.electronAPI.onAudioAnswerReady((data) => {
        setTranscript(data.transcript)
        setAnswer(data.answer)
        setError("")
        setStatus("idle")
      }),
      window.electronAPI.onAudioAnswerError((nextError) => {
        setError(nextError)
        setStatus("idle")
      })
    ]

    return () => {
      cleanup.forEach((fn) => fn())
    }
  }, [])

  const stopTracks = () => {
    captureStreamRef.current?.getTracks().forEach((track) => track.stop())
    captureStreamRef.current = null
  }

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== "inactive") {
      recorder.stop()
    } else {
      stopTracks()
      mediaRecorderRef.current = null
      setStatus("idle")
    }
  }

  const startRecording = async () => {
    if (!isSupported) {
      setStatus("unsupported")
      return
    }

    if (!enabledRef.current) {
      setError("Enable audio capture in Settings before starting a recording.")
      return
    }

    setError("")
    setAnswer("")
    setTranscript("")
    setProgressMessage("Waiting for Windows system-audio permission...")
    setProgressValue(5)

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true
      })

      const audioTracks = displayStream.getAudioTracks()
      displayStream.getVideoTracks().forEach((track) => track.stop())

      if (!audioTracks.length) {
        displayStream.getTracks().forEach((track) => track.stop())
        throw new Error("No system audio track was available. Choose a screen with audio sharing enabled and try again.")
      }

      const stream = new MediaStream(audioTracks)
      captureStreamRef.current = stream

      const preferredMimeTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "video/webm;codecs=vp8,opus",
        "video/webm"
      ]
      const selectedMimeType = preferredMimeTypes.find((mimeType) =>
        MediaRecorder.isTypeSupported(mimeType)
      )

      const recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream)

      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = async () => {
        stopTracks()
        mediaRecorderRef.current = null
        setStatus("processing")
        setProgressMessage("Preparing recorded audio...")
        setProgressValue(10)

        try {
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "audio/webm"
          })
          const buffer = await blob.arrayBuffer()
          const bytes = Array.from(new Uint8Array(buffer))
          await window.electronAPI.processAudioQuestion({
            audioData: bytes,
            mimeType: blob.type || recorder.mimeType || "audio/webm"
          })
        } catch (nextError: any) {
          console.error("Failed to submit recorded audio:", nextError)
          setError(nextError?.message || "Failed to submit recorded audio.")
          setStatus("idle")
        }
      }

      recorder.start()
      setStatus("recording")
      setProgressMessage("Recording system audio. Press Ctrl/Cmd+J again to stop.")
      setProgressValue(0)
    } catch (nextError: any) {
      console.error("Failed to start audio capture:", nextError)
      stopTracks()
      setStatus("idle")
      setError(
        nextError?.message ||
          "Unable to start audio capture. Check Windows permissions and try again."
      )
    }
  }

  const toggleRecording = async () => {
    if (statusRef.current === "processing") {
      return
    }

    if (statusRef.current === "recording") {
      stopRecording()
      return
    }

    if (providerRef.current !== "openai") {
      setError("Switch the API provider to OpenAI in Settings to use audio capture.")
      return
    }

    await startRecording()
  }

  if (!enabled) {
    return null
  }

  return (
    <div className="mb-3 min-h-[132px] rounded-xl border border-emerald-300/20 bg-black/70 px-4 py-3 text-white shadow-lg shadow-emerald-950/20">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold tracking-wide">
              Audio Interview Capture
            </h2>
            <p className="text-xs text-white/60">
              Capture system audio and turn interview questions into a spoken answer. Shortcut: Ctrl/Cmd+J.
            </p>
          </div>
          <Button
            onClick={() => {
              void toggleRecording()
            }}
            disabled={status === "processing" || status === "unsupported" || provider !== "openai"}
            className={`min-w-32 ${
              status === "recording"
                ? "bg-red-500 text-white hover:bg-red-400"
                : "bg-emerald-300 text-black hover:bg-emerald-200"
            }`}
          >
            {status === "recording"
              ? "Stop Recording"
              : status === "processing"
                ? "Processing..."
                : "Start Listening"}
          </Button>
        </div>

        {!isSupported ? (
          <p className="text-xs text-amber-300/90">
            Audio capture is currently available on Windows only.
          </p>
        ) : provider !== "openai" ? (
          <p className="text-xs text-amber-300/90">
            Audio capture uses OpenAI transcription and answering. Switch the provider to OpenAI in Settings to enable it.
          </p>
        ) : null}

        {(status === "processing" || status === "recording" || progressMessage) && isSupported ? (
          <div className="space-y-2">
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-emerald-300 transition-[width] duration-200"
                style={{ width: `${Math.max(progressValue, status === "recording" ? 100 : 0)}%` }}
              />
            </div>
            <p className="text-xs text-white/70">{progressMessage}</p>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-100">
            {error}
          </div>
        ) : null}

        {transcript ? (
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">
              Transcript
            </p>
            <div className="rounded-lg bg-white/5 px-3 py-2 text-sm text-white/85">
              {transcript}
            </div>
          </div>
        ) : null}

        {answer ? (
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">
              Suggested Answer
            </p>
            <div className="rounded-lg border border-emerald-300/15 bg-emerald-300/10 px-3 py-3 text-sm leading-6 text-white/90">
              {answer}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
