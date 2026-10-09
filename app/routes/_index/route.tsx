import { redirect, LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  throw redirect(`/app?${url.searchParams.toString()}`);
};

export default function App() {
  return null;
}
