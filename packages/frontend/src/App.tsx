import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { WebVitalsReporter } from '@/components/WebVitalsReporter'
import { AuthProvider } from '@/context/AuthContext'
import { createQueryClient } from '@/lib/query'
import { RealtimeProvider } from '@/lib/realtime/RealtimeProvider'
import { AppRouter } from '@/router/AppRouter'

function App() {
  const [queryClient] = useState(createQueryClient)
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          {/* How fast pages were for this session (FMS-75), reported to the API's metrics; production builds only. */}
          <WebVitalsReporter />
          {/* Live updates over Socket.IO while signed in (FMS-43). */}
          <RealtimeProvider>
            <AppRouter />
          </RealtimeProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
