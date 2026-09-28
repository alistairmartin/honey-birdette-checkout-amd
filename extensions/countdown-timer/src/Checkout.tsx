import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { useSettings } from "@shopify/ui-extensions/checkout/preact";

type BannerTone = "info" | "success" | "warning" | "critical";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const {
    countdown,
    titleBefore,
    descriptionBefore,
    statusBefore,
    collapsibleBefore,
    titleAfter,
    descriptionAfter,
    statusAfter,
  } = useSettings();

  const countdownDate = countdown
    ? new Date(String(countdown))
    : new Date("2025-01-01T12:30:00");
  const countdownTime = countdownDate.getTime();
  const titleBeforeSetting = titleBefore ? String(titleBefore) : "Sale Will End In...";
  const descriptionBeforeSetting = descriptionBefore
    ? descriptionBefore
    : "Make sure to checkout before the countdown finishes.";
  const statusBeforeSetting = (statusBefore ? statusBefore : "warning") as BannerTone;
  const collapsibleBeforeSetting = collapsibleBefore ? true : false;

  const [timeLeft, setTimeLeft] = useState(calculateTimeLeft(countdownTime));

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(calculateTimeLeft(countdownTime));
    }, 1000);

    return () => clearInterval(timer);
  }, [countdownTime]);

  if (timeLeft.total <= 0) {
    return (
      <s-banner
        heading={titleAfter ? String(titleAfter) : undefined}
        // The legacy Banner defaulted to "info" when no status was set.
        tone={(statusAfter ? statusAfter : "info") as BannerTone}
      >
        {descriptionAfter}
      </s-banner>
    );
  }

  return (
    <s-banner
      heading={titleBeforeSetting}
      tone={statusBeforeSetting}
      collapsible={collapsibleBeforeSetting}
    >
      <s-stack direction="block" gap="base" paddingBlockStart="base">
        <s-text type="strong">
          {timeLeft.days}d {timeLeft.hours}h {timeLeft.minutes}m {timeLeft.seconds}s
        </s-text>
        <s-paragraph color="subdued">
          <s-text type="offset">{descriptionBeforeSetting}</s-text>
        </s-paragraph>
      </s-stack>
    </s-banner>
  );
}

function calculateTimeLeft(targetTime: number) {
  const difference = targetTime - Date.now();

  return {
    total: difference,
    days: Math.floor(difference / (1000 * 60 * 60 * 24)),
    hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((difference / 1000 / 60) % 60),
    seconds: Math.floor((difference / 1000) % 60),
  };
}
