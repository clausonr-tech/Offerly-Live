import PostForm from "./PostForm";

/** Where the + in the Community nav lands: a student writing something for
 *  the live feed. Open to everyone; /networking/compose is the org equivalent and
 *  stays gated. */
export default function NewPostPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <PostForm />
    </div>
  );
}
