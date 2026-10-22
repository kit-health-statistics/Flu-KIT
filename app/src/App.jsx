import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import ForecastleGame from './components/forecastle/ForecastleGame';

const App = () => (
  <HelmetProvider>
    <Router>
      <Routes>
        <Route path="/" element={<ForecastleGame />} />
        <Route path="/forecastle" element={<ForecastleGame />} />
      </Routes>
    </Router>
  </HelmetProvider>
);

export default App;