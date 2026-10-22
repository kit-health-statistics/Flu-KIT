import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import App from './App.jsx'
import { theme } from './theme/mantine.js'
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
    >
      <App />
    </MantineProvider>
  </StrictMode>,
)