import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
await authenticate.admin(request);
return null;
};

export default function Index() {
return ( <s-page heading="FasPe Checkout"> <s-section heading="Welcome to FasPe"> <s-paragraph>
Manage your checkout experience for your Shopify store. </s-paragraph> </s-section>


  <s-section heading="Checkout overview">
    <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="base">
      <s-grid-item>
        <s-box padding="large" borderWidth="base" borderRadius="large">
          <s-heading>Checkout status</s-heading>
          <s-paragraph>Setup in progress</s-paragraph>
        </s-box>
      </s-grid-item>
      <s-grid-item>
        <s-box padding="large" borderWidth="base" borderRadius="large">
          <s-heading>Payment gateway</s-heading>
          <s-paragraph>Not connected yet</s-paragraph>
        </s-box>
      </s-grid-item>
    </s-grid>
  </s-section>

  <s-section heading="Next steps">
    <s-unordered-list>
      <s-list-item>Build the new checkout interface.</s-list-item>
      <s-list-item>Configure the payment gateway.</s-list-item>
      <s-list-item>Test the checkout flow locally.</s-list-item>
    </s-unordered-list>
  </s-section>
</s-page>


);
}

export const headers: HeadersFunction = (headersArgs) => {
return boundary.headers(headersArgs);
};
