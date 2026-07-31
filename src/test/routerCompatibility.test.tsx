import { fireEvent, render, screen } from "@testing-library/react";
import {
  Link,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";

function ProjectRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projectId } = useParams();

  return (
    <>
      <h1>Project {projectId}</h1>
      <p>{location.pathname}</p>
      <Link to="/projects/next">Next link</Link>
      <button type="button" onClick={() => navigate("/projects/final")}>
        Final project
      </button>
    </>
  );
}

describe("React Router compatibility", () => {
  it("supports declarative routes, params, links, navigation and redirects", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Navigate to="/projects/initial" replace />} />
          <Route path="/projects/:projectId" element={<ProjectRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Project initial" })).toBeInTheDocument();
    expect(screen.getByText("/projects/initial")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Next link" }));
    expect(await screen.findByRole("heading", { name: "Project next" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Final project" }));
    expect(await screen.findByRole("heading", { name: "Project final" })).toBeInTheDocument();
  });
});
