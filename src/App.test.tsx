import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("foundation app shell", () => {
  it("explains the current foundation-only phase", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "SNS Marketing Manager" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "SNS管理機能や外部サービス接続はまだ実装していません",
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "後続機能のための安全な土台" }),
    ).toBeInTheDocument();
  });

  it("opens and closes the checklist with an accessible button", async () => {
    const user = userEvent.setup();
    render(<App />);

    const toggle = screen.getByRole("button", { name: "確認項目を表示" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("SNSへの自動投稿は行いません。")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(screen.getByRole("button", { name: "確認項目を閉じる" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("SNSへの自動投稿は行いません。")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "確認項目を閉じる" }));
    expect(screen.queryByText("SNSへの自動投稿は行いません。")).not.toBeInTheDocument();
  });
});
