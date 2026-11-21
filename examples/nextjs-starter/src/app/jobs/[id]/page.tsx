import JobDetail from '@/components/JobDetail';

export default function JobPage({ params }: { params: { id: string } }) {
  return (
    <main className="container">
      <h1>📊 Job #{params.id}</h1>
      <JobDetail jobId={BigInt(params.id)} />
    </main>
  );
}
