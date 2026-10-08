// 흉고로 나무 모양(높이·수관폭·수관 시작 높이)을 추정한다. 3D 지도와 한 그루 3D가 같이 쓴다.
// 계수는 data/tree_form.json(가정값)이며 표시 전용이다.

export function estimateForm(dbh, info, form) {
  const shapeKey = (info && info.crown_shape) || "round";
  const shape = form.shapes[shapeKey];
  const hmax = form.height.max_height_m[(info && info.mature_height_class) || "medium"];
  const h = 1.3 + (hmax - 1.3) * (1 - Math.exp(-form.height.k * dbh));
  const cw = Math.min((form.crown_width.a + form.crown_width.b * dbh) * shape.width_factor,
    h * form.crown_width.max_ratio_to_height);
  return { shape: shapeKey, h, cw, base: h * shape.crown_base_ratio };
}
