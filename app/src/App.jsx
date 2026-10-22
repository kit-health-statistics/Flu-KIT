import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import ForecastleGame from './components/forecastle/ForecastleGame';

const App = () => (
  <HelmetProvider>
    <Router basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<ForecastleGame />} />
        <Route path="/forecastle" element={<ForecastleGame />} />
      </Routes>
    </Router>
  </HelmetProvider>
);

export default App;