import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  return (
    <s-announcement onDismiss={() => console.log('announcement dismissed')}>
      <s-text>Enjoy 10% off your next order.</s-text>{' '}
      <s-link command="--show" commandFor="offer-modal">
        See details
      </s-link>

      <s-modal id="offer-modal" heading="Your 10% off, explained">
        <s-stack gap="base">
          <s-text>
            Use code TREAT10 at checkout on your next order. One use per
            customer, valid for 30 days, excludes gift cards.
          </s-text>
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor="offer-modal"
        >
          Got it
        </s-button>
      </s-modal>
    </s-announcement>
  );
}
