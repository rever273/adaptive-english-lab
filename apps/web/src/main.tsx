import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "primeicons/primeicons.css";
import "./styles/01-base.css";
import "./styles/02-shell-analytics.css";
import "./styles/03-look-and-feel.css";
import "./styles/04-vocabulary-tables.css";
import "./styles/05-typing.css";
import "./styles/06-journey.css";
import "./styles/07-word-lesson.css";
import "./styles/08-grammar-cloze.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
