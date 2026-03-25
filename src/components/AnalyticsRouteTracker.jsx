import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { trackPageView } from "../firebase";

export default function AnalyticsRouteTracker() {
  const location = useLocation();

  useEffect(() => {
    const fullPath = `${location.pathname}${location.search}${location.hash}`;
    trackPageView(fullPath);
  }, [location.pathname, location.search, location.hash]);

  return null;
}
