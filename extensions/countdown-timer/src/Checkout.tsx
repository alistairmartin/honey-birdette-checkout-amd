import {
  reactExtension,
  Banner,
  BlockStack,
  BlockSpacer,
  useTranslate,
  useSettings,
  Text,
  TextBlock,
} from "@shopify/ui-extensions-react/checkout";
import { useState, useEffect } from "react";

export default reactExtension("purchase.checkout.block.render", () => (
  <Extension />
));

function Extension() {
  const translate = useTranslate();
  const { countdown, titleBefore, descriptionBefore, statusBefore, collapsibleBefore, titleAfter, descriptionAfter, statusAfter, collapsibleAfter } = useSettings();
  const countdownDate = countdown ? new Date(countdown) : new Date("2025-01-01T12:30:00");
  const titleBeforeSetting = titleBefore ? titleBefore : "Sale Will End In...";
  const descriptionBeforeSetting = descriptionBefore ? descriptionBefore : "Make sure to checkout before the countdown finishes.";
  const statusBeforeSetting = statusBefore ? statusBefore : "warning";
  const collapsibleBeforeSetting = collapsibleBefore ? collapsibleBefore : false;
  const [timeLeft, setTimeLeft] = useState(calculateTimeLeft(countdownDate));

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(calculateTimeLeft(countdownDate));
    }, 1000);

    return () => clearInterval(timer);
  }, [countdownDate]);

  if (timeLeft.total <= 0) {
    return (

      <Banner title={titleAfter} status={statusAfter}>
        {descriptionAfter}
      </Banner>
    );
  }

  // {translate("time-remaining", {
  //   target: (
  //     <Text emphasis="bold" size="medium">
  //       {timeLeft.days}d {timeLeft.hours}h {timeLeft.minutes}m {timeLeft.seconds}s
  //     </Text>
  //   ),
  // })}

  return (
    <BlockStack>


      <Banner title={titleBeforeSetting} status={statusBeforeSetting} collapsible={collapsibleBeforeSetting}>
        <BlockSpacer spacing="base" />  
            <Text emphasis="bold" size="medium">
              {timeLeft.days}d {timeLeft.hours}h {timeLeft.minutes}m {timeLeft.seconds}s
            </Text>
      <BlockSpacer spacing="base" />  
      <TextBlock appearance="subdued" emphasis="italic">
      {descriptionBeforeSetting}
      </TextBlock>
      </Banner>

   

     


     
     
   
    </BlockStack>
  );
}

function calculateTimeLeft(targetDate) {
  const now = new Date();
  const difference = targetDate - now;

  let timeLeft = {
    total: difference,
    days: Math.floor(difference / (1000 * 60 * 60 * 24)),
    hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((difference / 1000 / 60) % 60),
    seconds: Math.floor((difference / 1000) % 60),
  };

  return timeLeft;
}
