import { redirect } from 'next/navigation';

export default function StocksIndex() {
  redirect('/stocks/analysis');
}
