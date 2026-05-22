import '@shopify/ui-extensions/preact';
import { render } from "preact";
import { useRef } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const processingRef = useRef(false);

  useSignalEffect(() => {
    const lines = shopify.lines.value;

    const linesToCheck = lines.filter(
      (line) => line.merchandise.type === 'variant' && line.quantity > 1
    );

    if (linesToCheck.length === 0 || processingRef.current) return;

    processingRef.current = true;

    Promise.all(
      linesToCheck.map(async (line) => {
        const { data } = await shopify.query(
          `query getProductTags($id: ID!) {
            product(id: $id) {
              tags
            }
          }`,
          { variables: { id: line.merchandise.product.id } }
        );

        const product = /** @type {any} */ (data)?.product;
        if (product?.tags?.includes('limit-1')) {
          await shopify.applyCartLinesChange({
            type: 'updateCartLine',
            id: line.id,
            quantity: 1,
          });
        }
      })
    ).finally(() => {
      processingRef.current = false;
    });
  });

  return null;
}
