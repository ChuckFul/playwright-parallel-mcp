export interface PreflightResult {
  listening: boolean;
  browser?: string;
  error?: string;
}

export async function checkCdpEndpoint(endpoint: string): Promise<PreflightResult> {
  let url: URL;
  try {
    url = new URL("/json/version", endpoint);
  } catch {
    return {
      listening: false,
      error: `Invalid CDP endpoint URL: ${endpoint}`
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        listening: false,
        error: `CDP endpoint returned ${response.status}`
      };
    }

    const data = await response.json() as { Browser?: string };
    return {
      listening: true,
      browser: data.Browser
    };
  } catch {
    return {
      listening: false,
      error: `CDP endpoint ${endpoint} not listening`
    };
  }
}
